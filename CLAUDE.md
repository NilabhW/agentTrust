# Agent Trust Gateway — CLAUDE.md

## Project status
Phase 1 (Mandate Service) is implemented: `src/mandate/` (model, canonical serialization, HMAC-SHA256 signer, validation, SQLite-backed store, Fastify routes) plus `src/db/`, `src/config.ts`, `src/app.ts`, `src/server.ts`, and `scripts/seed.ts`. Full Vitest coverage lives in `test/mandate/`.

Phase 2 (Audit Log + minimal UI, Program 4) is implemented ahead of the Gateway: `src/audit/` (append-only `audit_log` table with DB-level UPDATE/DELETE triggers, `AuditStore.writeEntry()`/`list()` with cursor pagination and filters, `GET /audit`), `src/ui/` + `public/index.html` (a single static page polling `/mandates` and `/audit` every 3s — mandate-overview progress bars + a color-coded audit table), and `scripts/seed-audit.ts` for demo data. `MandateStore.listAll()` was added and `GET /mandates`'s `user_id` is now optional (omitted = all mandates) to support the overview panel. **Not yet built**: the pending-approvals panel and `GET /mandates/pending-approvals` — deliberately deferred until Program 2 (Verification Gateway) exists, since there's no step-up producer yet. The Verification Gateway and Razorpay integration (Programs 2-3) are not yet built.

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
- Seed demo data: `npm run seed` (mandates) then `npm run seed:audit` (audit log entries — requires mandates to exist first)

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
