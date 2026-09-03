# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project
Agent Trust Gateway is a signed-mandate verification layer for Razorpay merchants: a human issues a spending mandate to an AI agent, the Verification Gateway checks every purchase request against that mandate's bounds before calling Razorpay's test-mode API, and every decision is written to an append-only audit trail.

Full spec — field-level schemas, endpoint lists, complete per-program test-case checklists: `agent-trust-gateway-buildspec.md` in the repo root. Treat it as the source of truth for scope; don't redesign a program's architecture without updating the spec first.

**Buildspec scope, current as of this writing**: the spec now names six programs. 1 (Mandate Service), 2 (Verification Gateway), 3 (Razorpay integration), 4 (Audit Log + UI), and 5 (Gemini buyer agent) are built. **Not yet built**: Program 6 (Groq-powered bounded upsell agent), and a correction to Program 3 calling for headless Checkout automation (Playwright/Puppeteer driving Razorpay's actual Checkout.js) in place of the current webhook-simulator approach (`scripts/simulate-payment.ts`) — that correction hasn't been applied yet; Program 3 still uses the simulator.

## Commands
Stack: Node.js + TypeScript, Fastify, better-sqlite3, Vitest.
- Install deps: `npm install`
- Run tests: `npm test` — prefer running a single test file while iterating, e.g. `npx vitest run test/mandate/store.test.ts`, not the full suite
- Run the dev server: `npm run dev` (requires `MANDATE_SIGNING_KEY`; see `.env.example` for all env vars, most of which are optional with sane defaults)
- Typecheck: `npm run typecheck`
- Build / run compiled: `npm run build` then `npm start` (compiles to `dist/`, copies `src/db/schema.sql` alongside it — the schema is read from disk at runtime, not bundled)
- Seed demo data: `npm run seed` (creates 3 demo mandates with real Ed25519 keypairs, private keys written to gitignored `data/demo-keys.json`) then optionally `npm run seed:audit` (sample audit history — requires mandates to exist first; skip this for a clean demo)
- Sign a demo agent request: `npm run sign-demo-request -- <mandate_id> [amount] [category] [item_description]` — prints a ready-to-paste `curl` command against `POST /gateway/verify`
- Simulate a Razorpay payment webhook: `npm run simulate-payment -- <order_id> <amount_rupees> [paid|failed]` — requires `RAZORPAY_WEBHOOK_SECRET` in the environment (matching the running server's); prints a ready-to-paste `curl` command against `POST /razorpay/webhook`
- Run the Gemini buyer agent: `npm run buyer-agent -- --canned <clean|step-up|hard-fail>` or `-- --goal "<free text>"` (optionally `--mandate <mandate_id>`) — requires `GEMINI_API_KEY` and the dev server already running (`npm run dev`); the agent talks to the Gateway over real HTTP, exactly like any external agent
- If you change `src/db/schema.sql`'s `CHECK` constraints, delete the local `data/mandates.db*` files and re-seed — `CREATE TABLE IF NOT EXISTS` does not retroactively alter an already-created table

## Architecture

```
Human sets rules → Mandate Service (stores signed spending permissions)
        ↓
AI Agent → Verification Gateway ("the bouncer") → Razorpay Integration (test-mode payments)
        ↓                                    ↓
        └──────────► Audit Log + UI ◄────────┘
```

Seven directories under `src/`, six of them wired together in `src/app.ts`'s `buildApp()` (the single place that constructs every store/service and registers every route — start here to see how the pieces connect):

- **`src/mandate/`** — issues, signs, stores, and revokes mandates. `canonical.ts` turns a mandate into one deterministic byte string before signing (`signer.ts`, HMAC-SHA256) — required for verification to be stable rather than flaky. Every read re-verifies the stored signature against the row's fields, throwing `MandateIntegrityError` on any mismatch, so direct DB tampering is detected rather than silently trusted. Cumulative spend is *computed* by summing `spend_events` rows, not stored as a counter, to keep the sliding-window semantics correct.
- **`src/gateway/`** — the bounds/gating decision logic; the core of the project. `service.ts`'s `verify()` runs, in order: shape validation → mandate fetch → agent-signature check (`agent-signature.ts`, Ed25519, a *different* scheme from the mandate's own HMAC) → replay check (`replay.ts`, in-memory nonce+timestamp cache, fresh per `buildApp()` call) → `bounds.ts`'s `evaluateBounds()` (a pure function: no DB calls, no clock reads, so it's unit-testable on input/output pairs alone). On `pass`, `MandateStore.incrementSpend()` runs *before* any Razorpay call — see the safety-ordering comment at that call site before ever inserting an `async` step between the bounds check and the increment. On `step_up`, a row goes into `pending_approvals` (`store.ts`) instead; `approveStepUp()` re-fetches and re-validates the mandate (not just the approval) before granting it, since a step-up can sit pending for minutes and revocation must stop the money even mid-flight.
- **`src/razorpay/`** — thin wrapper around Razorpay's real test-mode Orders API, only ever called by the Gateway, never reachable directly by an agent. `webhook-signature.ts` is a *third*, separate HMAC scheme (Razorpay's webhook secret, raw-body message) — see "Why three signature schemes" below. `orders-store.ts`'s `orders` table exists because Razorpay's webhooks carry only `order_id`/`payment_id`, never `mandate_id`; it's both the attribution source and the idempotency guard for webhook processing. `webhook-service.ts` deliberately lets a later `order.paid` win over an earlier `payment.failed` on the same order (Razorpay fires `payment.failed` per failed *attempt*, not per order — a retried payment can still succeed).
- **`src/audit/`** — append-only `audit_log`, enforced by DB-level `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT, ...)`, not just application-level convention. `AuditStore.writeEntry()`/`list()` (cursor pagination via `before_id`, not `created_at`, since timestamps can collide).
- **`src/ui/`** — serves the single static dashboard page (`public/index.html`, no build step — edits take effect on next page load).
- **`src/demo/`** — convenience routes (`GET /demo/agents`, `POST /demo/purchase`, `POST /demo/settle`) that exist only so the dashboard can be clicked through without a terminal. They read demo private keys straight off disk (`data/demo-keys.json`) and sign/settle on the agent's behalf server-side — **not a template for a real integration**; a real agent holds and uses its own key, and a real payment settlement always goes through webhook signature verification. These routes fail closed (empty/400) if `data/demo-keys.json` doesn't exist.
- **`src/agent/`** — the Program 5 Gemini buyer agent. Not part of `buildApp()`/not a Fastify route at all: it's a standalone client, invoked via `scripts/run-buyer-agent.ts`, that talks to an already-running Gateway over **real HTTP** (unlike `src/demo/`'s in-process shortcuts) — per the buildspec, "exactly like any external agent would." `catalog.ts` is a static mock item list; `gemini-client.ts` is a thin `fetch`-based wrapper around Gemini's REST `generateContent` endpoint (mirrors `RazorpayClient`'s shape: injectable `fetchImpl`, `AbortSignal.timeout()`-bounded, API key via header not query string); `tools.ts` declares `browse_catalog`/`submit_purchase` and implements them — `submit_purchase` reuses `gateway/agent-signature.ts`'s `signAgentRequest()` unmodified and is the *only* path to a purchase, with no import of `src/razorpay/` anywhere in this module; `loop.ts` is the actual agentic loop (call Gemini → execute any tool calls → feed results back → repeat until the model stops calling tools or a turn cap is hit), deliberately telling the agent its allowed categories but not its numeric spending caps, so it has to discover its own limits by trying — same as a real agent would. The agent's reasoning transcript is printed live to the terminal, not written into `audit_log` (that table's `decision` enum means "a Gateway/Razorpay decision," not free-text reasoning) — the intended demo is the terminal (agent reasoning) and the dashboard (Gateway enforcement) side by side.

### Why three signature schemes
| Module | Protects | Algorithm / key |
|---|---|---|
| `mandate/signer.ts` | A mandate's terms haven't been edited since creation | HMAC-SHA256, `MANDATE_SIGNING_KEY` |
| `gateway/agent-signature.ts` | A purchase request really came from the agent holding that mandate's key | Ed25519, per-mandate keypair |
| `razorpay/webhook-signature.ts` | A webhook claiming to be from Razorpay really is | HMAC-SHA256, `RAZORPAY_WEBHOOK_SECRET` |

Each protects a different trust relationship with a different key — never reuse one scheme's verification code for another.

### Razorpay wiring is fully optional
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET` are plain optional env vars. `buildApp()` only constructs a `RazorpayClient` when the key id/secret are both present, and only registers `POST /razorpay/webhook` when the webhook secret is present (unregistered, not just disabled — hitting it 404s). With nothing set, the Gateway still fully enforces every rule; `order_id` just stays `null` and no `order_created`/`payment_captured`/`payment_failed` entries are written. This is a regression-tested guarantee (`test/gateway/service.razorpay.test.ts`), not just an assumption.

## Design principles (the "why" behind the rules below)
- **Signing is the trust boundary.** Mandates are cryptographically signed so the Gateway can verify authenticity without trusting the caller; agent requests are separately signed with a per-mandate keypair issued at mandate-creation time.
- **Step-up vs. hard-fail is a deliberate policy split, not a default.** Only "would exceed cumulative cap" gets a human-in-the-loop retry path. Bad signature, expired mandate, revoked mandate, and out-of-scope category are all immediate hard fails. Don't collapse these into each other without flagging it explicitly.
- **Audit logging is a functional requirement, tested directly** — not instrumentation bolted on after the fact. Every decision branch must produce exactly one correctly-reasoned entry, and the log must be genuinely append-only.
- **Bounds-checking is a pure function**, by design, for testability: no DB calls, no Razorpay calls inside the decision function itself.

## Code style
- Normalize all Gateway decisions to `{decision: pass | hard_fail | step_up, reason}` — every caller branches on this shape, not on ad-hoc booleans.
- All signing and signature-verification code lives in one module per scheme. Never inline a signature check elsewhere.

## Workflow rules
- **Before writing any Razorpay integration code, fetch Razorpay's current test-mode API docs.** Field names and endpoint shapes drift — this is the highest-risk area for silent bugs, don't rely on memorized specifics.
- Every Gateway decision branch (pass, hard-fail, step-up-requested, step-up-approved, step-up-denied, step-up-timeout) must write exactly one audit entry. Adding a new branch means adding its test case to the spec before implementing it, and adding the value to both `DECISIONS` (`src/audit/types.ts`) and the `CHECK` constraint (`src/db/schema.sql`).
- The audit log is append-only. Never add an UPDATE or DELETE path — fix forward with a new entry, not by editing history.
- IMPORTANT: never hardcode Razorpay API keys, webhook secrets, or signing keys. Env vars only. Never print them in logs, error messages, or commits.
- Run the `security-reviewer` subagent (`.claude/agents/security-reviewer.md`) after any change to signing logic, bounds-checking, or the webhook handler — before merging, not after.
- After implementing a program, run its test cases from the build spec before starting the next one.

## Testing
- Test cases for all four programs live in `agent-trust-gateway-buildspec.md` — treat that list as acceptance criteria, not a suggestion.
- Don't consider the Verification Gateway "done" on happy-path tests alone — the replay, expiry, revocation, and step-up test cases are the ones that actually matter for this project's premise.
- Test files mirror source 1:1: `test/<module>/<layer>.test.ts`. Every source file's test is written and confirmed failing before implementation (this repo is built test-first throughout).

## Repo etiquette
- Commit messages state which program + what changed, e.g. `gateway: add replay protection via nonce cache`.
- Github repo: `NilabhW/agentTrust`.

## Known, accepted limitations
Deliberate, documented trade-offs — not bugs to silently fix:
1. `POST /mandates` has no authentication — anyone reaching the service can mint a mandate for any `user_id`. A real fix requires a whole-system auth decision (operator sessions vs. API keys) that hasn't been made yet.
2. The replay-protection nonce cache is in-memory and per-process (per the buildspec's explicit hackathon-stage allowance) — resets on restart, isn't shared across instances behind a load balancer.
3. Spend is incremented *before* `create_order()` is called (Program 3's call must sit after `incrementSpend()`, never between the bounds check and the increment — see the safety-ordering comment in `gateway/service.ts`). If `create_order()` then fails, the spend stays committed even though no order exists — visible in the audit trail as `payment_failed`, not automatically reversed.
4. There is no request-level idempotency key beyond `ReplayGuard`'s nonce, which only catches a byte-identical resubmission. A client-side retry after a timeout carries a fresh nonce and signature, so it's indistinguishable from a genuinely new purchase and can double-increment spend for what the agent considers one purchase. Closing this needs an agent-supplied idempotency key threaded through the signed request schema — a protocol change, not done.

## Implementation history
Built in six phases, each test-first: (1) Mandate Service, (2) Audit Log + minimal UI (built ahead of the Gateway so every later program could log from day one), (3) Verification Gateway, (4) Razorpay test-mode integration, (5) interactive demo UI (`src/demo/`, real Approve/Deny buttons, redesigned dashboard), (6) Gemini buyer agent (`src/agent/`, Program 5 — a real model making purchasing decisions against the already-built infrastructure, over real HTTP). A `security-reviewer` pass ran on phases that touched signing/bounds/webhook code (1–4); phase 6 reuses existing signing code unmodified and touches neither bounds-checking nor the webhook handler, so it was skipped there, per CLAUDE.md's own scoping of that rule. `README.md` covers the problem/solution/architecture for an external reader.
