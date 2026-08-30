# Agent Trust Gateway — CLAUDE.md

## Project status
Phase 1 (Mandate Service) is implemented: `src/mandate/` (model, canonical serialization, HMAC-SHA256 signer, validation, SQLite-backed store, Fastify routes) plus `src/db/`, `src/config.ts`, `src/app.ts`, `src/server.ts`, and `scripts/seed.ts`. Full Vitest coverage lives in `test/mandate/`.

Phase 2 (Audit Log + minimal UI, Program 4) is implemented ahead of the Gateway: `src/audit/` (append-only `audit_log` table with DB-level UPDATE/DELETE triggers, `AuditStore.writeEntry()`/`list()` with cursor pagination and filters, `GET /audit`), `src/ui/` + `public/index.html` (a single static page polling `/mandates` and `/audit` every 3s — mandate-overview progress bars + a color-coded audit table), and `scripts/seed-audit.ts` for demo data. `MandateStore.listAll()` was added and `GET /mandates`'s `user_id` is now optional (omitted = all mandates) to support the overview panel.

Phase 3 (Verification Gateway, Program 2) is implemented: `src/gateway/` — `agent-signature.ts` (the sole Ed25519 sign/verify module for agent request signatures, a second scheme alongside `mandate/signer.ts`'s HMAC; `agent_public_key` is a base64url-encoded raw 32-byte Ed25519 public key, `agent_signature` is a hex-encoded raw 64-byte signature), `replay.ts` (in-memory nonce+timestamp cache, keyed per-mandate, fresh per `buildApp()` call), `bounds.ts` (the pure `evaluateBounds()` decision function), `store.ts` (`PendingApprovalStore`, with lazy timeout-materialization guarded by SQLite's own `changes` count so a `step_up_timeout` audit entry is never double-written), `service.ts` (orchestration), and `routes.ts` (`POST /gateway/verify`, `POST /gateway/pending-approvals/:id/{approve,deny}`, `GET /gateway/pending-approvals` aliased at `GET /mandates/pending-approvals`). `scripts/seed.ts` now generates real Ed25519 keypairs per demo mandate (private keys written to gitignored `data/demo-keys.json`); `scripts/sign-demo-request.ts` is a new helper that prints a ready-to-paste signed curl command.

**Scope note**: this phase makes zero calls to Program 3 (Razorpay doesn't exist yet). A `pass` or `step_up_approved` decision calls `MandateStore.incrementSpend()` and writes its audit entry, but stops there — `order_id` is always `null`, and no `order_created` entry is written. `GatewayService.verify()`'s pass/approve paths are exactly where Program 3 plugs in next — see the safety-ordering comment at that call site before inserting anything `async` there. **Not yet built**: Program 3 (Razorpay integration) and interactive approve/deny buttons in the UI (the backend endpoints exist and are tested; the UI currently only *lists* pending approvals read-only — see below).

**Security review findings addressed this phase** (run via the `security-reviewer` subagent): the Gateway no longer returns `pending_approval_id` to the agent in `POST /gateway/verify`'s response — the agent that triggers a step-up must never learn its own approval id, since the approve/deny endpoints have no separate operator credential and returning it would let an agent self-approve past `max_cumulative`. `approveStepUp()` now re-fetches and re-validates the mandate (revoked/expired) before incrementing spend, since a step-up can sit pending for minutes and revocation must stop the money even mid-flight — a pending approval against a mandate that became invalid in the meantime is now auto-resolved as a hard-fail, not silently approved. Fixed an off-by-one in `ReplayGuard`'s pruning that allowed exactly one replay at the far edge of the timestamp skew window. Added HTML-escaping to `public/index.html`'s rendering (it interpolates `audit_log` fields, including `mandate_id`, which is validated only as "non-empty string" and is loggable pre-signature-check by design — was vulnerable to stored HTML injection into the operator console). Numeric env vars (`REPLAY_SKEW_MS`, `STEP_UP_TIMEOUT_MS`, `PORT`) are now validated at startup so a typo can't silently produce `NaN` and disable a bound. `public/index.html` now also polls `GET /gateway/pending-approvals` (read-only list, no buttons yet) so an abandoned step-up's lazy timeout-materialization actually gets triggered during normal operation, rather than only when something happens to call that endpoint.

**Known, accepted limitations** (flagged by the review, deliberately not fixed this phase — pre-existing or architecture-level, not bugs in this phase's diff): (1) `POST /mandates` has no authentication — anyone reaching the service can mint a mandate for any `user_id`, so the Gateway's bounds enforcement is only as strong as an issuance path that currently has none; a real fix requires a whole-system auth decision (operator sessions vs. API keys) that hasn't been made yet. (2) The replay-protection nonce cache is in-memory and per-process (per the buildspec's explicit hackathon-stage allowance) — it resets on every restart/deploy and isn't shared across instances behind a load balancer, so a request replayed within the skew window survives a restart. A production hardening pass would move it into SQLite (a `seen_nonces` table with a unique index) instead.

## Project
A signed-mandate verification layer for Razorpay merchants: a human issues a spending mandate to an AI agent, the Verification Gateway checks every purchase request against that mandate's bounds before calling Razorpay's test-mode API, and every decision is written to an append-only audit trail.

Full spec — field-level schemas, endpoint lists, complete per-program test-case checklists: `agent-trust-gateway-buildspec.md` in the repo root. Treat it as the source of truth for scope; don't redesign a program's architecture without updating the spec first.

## Architecture
```
Human sets rules → Mandate Service (stores signed spending permissions)
        ↓
AI Agent → Verification Gateway ("the bouncer") → Razorpay Integration (test-mode payments)
        ↓                                    ↓
        └──────────► Audit Log + UI ◄────────┘
```
1. **Mandate Service** — issues, signs, stores, and revokes mandates
2. **Verification Gateway** — the bounds/gating decision logic; calls Razorpay only on pass
3. **Razorpay Integration Layer** — thin API wrapper, only ever called by the Gateway, never reachable directly by an agent
4. **Audit Log + UI** — append-only; written to by both the Gateway and the Razorpay layer

## Design principles (the "why" behind the rules below)
- **Signing is the trust boundary.** Mandates are cryptographically signed so the Gateway can verify authenticity without trusting the caller; agent requests are separately signed with a per-mandate keypair issued at mandate-creation time. Canonical JSON serialization must be stable, or verification will be flaky.
- **Step-up vs. hard-fail is a deliberate policy split, not a default.** Only "would exceed cumulative cap" gets a human-in-the-loop retry path. Bad signature, expired mandate, revoked mandate, and out-of-scope category are all immediate hard fails. Don't collapse these into each other without flagging it explicitly.
- **Audit logging is a functional requirement, tested directly** — not instrumentation bolted on after the fact. Every decision branch must produce exactly one correctly-reasoned entry, and the log must be genuinely append-only.
- **Bounds-checking is a pure function**, by design, for testability: no DB calls, no Razorpay calls inside the decision function itself, so it can be unit tested against the spec's test cases without mocking anything.

## Bash commands
Stack: Node.js + TypeScript, Fastify, better-sqlite3, Vitest.
- Install deps: `npm install`
- Run tests: `npm test` — prefer running a single test file while iterating, e.g. `npx vitest run test/mandate/store.test.ts`, not the full suite
- Run the dev server: `npm run dev` (requires `MANDATE_SIGNING_KEY`, `DB_PATH`, `PORT` env vars — see `.env.example`)
- Lint/typecheck: `npm run typecheck`
- Seed demo data: `npm run seed` (mandates, now with real Ed25519 keypairs written to gitignored `data/demo-keys.json`) then `npm run seed:audit` (audit log entries — requires mandates to exist first)
- Sign a demo agent request: `npm run sign-demo-request -- <mandate_id> [amount] [category] [item_description]` — prints a ready-to-paste `curl` command against `POST /gateway/verify`

## Code style
- Normalize all Gateway decisions to `{decision: pass | hard_fail | step_up, reason}` — every caller branches on this shape, not on ad-hoc booleans.
- All signing and signature-verification code lives in one module. Never inline a signature check elsewhere.

## Workflow rules
- **Before writing any Razorpay integration code, fetch Razorpay's current test-mode API docs.** Field names and endpoint shapes drift — this is the highest-risk area for silent bugs, don't rely on memorized specifics.
- Every Gateway decision branch (pass, hard-fail, step-up-requested, step-up-approved, step-up-denied, step-up-timeout) must write exactly one audit entry. Adding a new branch means adding its test case to the spec before implementing it.
- The audit log is append-only. Never add an UPDATE or DELETE path — fix forward with a new entry, not by editing history.
- IMPORTANT: never hardcode Razorpay API keys, webhook secrets, or signing keys. Env vars only. Never print them in logs, error messages, or commits.
- After implementing a program, run its test cases from the build spec before starting the next one.

## Testing
- Test cases for all four programs live in `agent-trust-gateway-buildspec.md` — treat that list as acceptance criteria, not a suggestion.
- Use Razorpay's documented test-mode cards/UPI credentials for payment simulation.
- Don't consider the Verification Gateway "done" on happy-path tests alone — the replay, expiry, revocation, and step-up test cases are the ones that actually matter for this project's premise.

## Repo etiquette
- One program per branch/PR where practical: `mandate-service`, `verification-gateway`, `razorpay-integration`, `audit-log-ui`.
- Commit messages state which program + what changed, e.g. `gateway: add replay protection via nonce cache`.
- Run the `security-reviewer` subagent (`.claude/agents/security-reviewer.md`) after any change to signing logic, bounds-checking, or the webhook handler — before merging, not after.
Github Repo name: agentTrust
Github profile name: NilabhW

## Suggested build order
1. Mandate Service — nothing else works without it.
2. Audit Log schema + `write_audit_entry()` — build early so every other program can log from day one.
3. Verification Gateway — the core logic.
4. Razorpay Integration — wire in once Gateway pass/fail decisions work.
5. Audit Log + UI frontend — polish last, once real data is flowing.
