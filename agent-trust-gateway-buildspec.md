# Agent Trust Gateway — Build Spec

Four programs, each broken into: Architecture → Detailed Features → Build Guide → Test Cases.

Diagram reference: Human sets rules stored by the **Mandate Service** → an **AI Agent** sends requests to the **Verification Gateway** → Gateway checks the Mandate Service, and on approval calls the **Razorpay Integration** layer → both the Gateway and Razorpay layer write every outcome to the **Audit Log + UI**.

---

## Program 1: Mandate Service

The "permission slip" system — creates, signs, stores, and revokes spending mandates.

### 1) Architecture
- Standalone module/microservice, sits upstream of the Verification Gateway.
- Storage: lightweight DB (SQLite for the hackathon; swap for Postgres if scaling).
- Core objects:
  - **Mandate** — the data model (see fields below)
  - **Signer** — crypto module (start with HMAC-SHA256; upgrade to ed25519 if time permits, since asymmetric signing lets the Gateway verify without holding the shared secret)
  - **MandateStore** — persistence layer
- Interfaces: REST endpoints for create / revoke / get / list mandates, plus an internal `increment_spend()` function called by the Gateway after every approved transaction.
- Recommendation: keep this as a module in the same codebase as the Gateway for the hackathon (less integration overhead), but keep it logically separated so it *could* be split out later.

### 2) Detailed features required
- **Create mandate**: input = user_id, agent_id, category scope (list), max_per_transaction, max_cumulative, rolling-window duration, expiry timestamp.
- **Sign mandate**: canonical JSON serialization → sign with server key → attach mandate_id (UUID) + signature.
- **Store mandate**: persist with `status = active`.
- **Revoke mandate**: sets `status = revoked`, effective immediately, no soft-delete ambiguity.
- **Get mandate by ID**: used by the Gateway on every verification call.
- **List mandates for a user**: powers the "what have I authorized" view in the UI.
- **Expiry handling**: compute `expired` at read-time (`now > expires_at`) rather than running a background job — simpler for a hackathon.
- **Category taxonomy**: fixed enum to start (e.g. `groceries`, `food_delivery`, `subscriptions`, `electronics`) — keeps scope-matching trivial.
- **Cumulative spend tracking**: Gateway calls `increment_spend(mandate_id, amount)` after every approved transaction; Mandate Service holds the running total so "how much has this mandate spent in the current window" is a fast, authoritative read.

### 3) Build guide
1. Define the Mandate schema/table (fields above).
2. Write the canonical serialization function — signatures must be over a consistent byte representation, or verification will be flaky.
3. Implement signing: HMAC-SHA256 first (fast to build), then ed25519 as a stretch goal.
4. Build `POST /mandates` (create).
5. Build `POST /mandates/{id}/revoke`.
6. Build `GET /mandates/{id}` and `GET /mandates?user_id=`.
7. Build the internal `increment_spend(mandate_id, amount)` function.
8. Add expiry-check logic to all GET responses.
9. Seed 2–3 example mandates so you have something to demo against immediately.

### 4) Test cases
- Create a mandate with valid fields → returns mandate_id + signature, `status = active`.
- Create a mandate missing a required field (e.g. no expiry) → rejected with a clear error.
- Tamper with a stored mandate's fields directly in the DB → signature verification fails on next read.
- Fetch a mandate after its `expires_at` has passed → returns `status = expired`.
- Revoke a mandate → subsequent verification attempts return `status = revoked`.
- Call `increment_spend` twice → cumulative total reflects both increments correctly.
- List mandates for a user with one active, one expired, one revoked → all three statuses reported correctly.

---

## Program 2: Verification Gateway ("the bouncer")

The core control point. Every purchase request passes through here before any money moves.

### 1) Architecture
- Sits as middleware in front of the checkout / order-creation flow.
- **Receives**: signed purchase request from the agent — `{mandate_id, agent_signature, amount, category, item_description, timestamp, nonce}`.
- **Calls out to**: Program 1 (fetch mandate + current cumulative spend), then Program 3 (only if verification passes).
- **Writes to**: Program 4, on every decision — pass, hard-fail, or step-up.
- **Triggers**: the step-up approval flow on a specific failure type (over-cap), rather than a hard reject.
- Keep it stateless where possible — state lives in the Mandate Service and the Audit Log, so the Gateway itself stays a thin decision layer.

### 2) Detailed features required
- **Agent-signature verification**: proves the request came from the agent holding the mandate's keys, not someone who stole the mandate_id. Requires issuing the agent a keypair at mandate-creation time.
- **Replay protection**: nonce + timestamp check. Reject requests with timestamps outside an allowed skew (e.g. ±2 minutes) or a nonce already seen (short-lived in-memory cache is fine).
- **Mandate status check**: active / not expired / not revoked (via Program 1).
- **Bounds checking**:
  - `amount ≤ max_per_transaction`
  - `(current cumulative spend + amount) ≤ max_cumulative`
  - `category ∈ scope`
- **Decision logic**: returns a structured result — `{decision: pass | hard_fail | step_up, reason}`.
- **Step-up flow**: on "would exceed cap" specifically (not on invalid signature or expired mandate — those are hard fails) — create a pending-approval record, notify the human, expose an approve/deny endpoint, resume on approval or auto-deny on timeout.
- **On pass**: call Program 3 → on success, call Program 1's `increment_spend` → log to Program 4.
- **Every path logged**: pass, hard-fail, step-up-created, step-up-approved, step-up-denied, step-up-timeout — all six get their own audit entry.

### 3) Build guide
1. Define the incoming request schema.
2. Implement agent-signature verification against the public key stored with the mandate.
3. Implement nonce + timestamp replay checking.
4. Wire up the call to Program 1 for mandate + cumulative spend lookup.
5. Implement bounds-checking as a **pure function** — easy to unit test in isolation, returns the structured decision result.
6. On pass → call Program 3 → call Program 1's `increment_spend` → log to Program 4.
7. On hard-fail → log to Program 4, return rejection with reason to the agent.
8. On step-up → create pending-approval record, log `step_up_requested`, notify the human (simplest version: write to a "pending approvals" table the frontend polls).
9. Build the human-facing approve/deny endpoint, wire it to resume the flow.
10. Add a timeout check — treat a pending approval past its `expires_at` as auto-denied.

### 4) Test cases
- Well-formed request, within all bounds → passes, order created, audit shows "approved."
- Tampered payload / invalid agent signature → hard rejected, reason = "invalid signature."
- Request against an expired mandate → hard rejected, reason = "mandate expired."
- Request against a revoked mandate → hard rejected, reason = "mandate revoked."
- Category outside scope → hard rejected, reason = "category not in scope."
- Amount over `max_per_transaction` → hard rejected (decide and document this policy consistently).
- Request that would push cumulative spend over `max_cumulative` → triggers step-up, pending-approval record created, audit shows "step_up_requested."
- Human approves the step-up → order created, audit shows "step_up_approved" → "order_created."
- Human denies the step-up → audit shows "step_up_denied," no order created.
- Step-up left unanswered past timeout → auto-denied, audit shows "step_up_timeout."
- Same signed request sent twice → second one rejected as duplicate/replay.
- Timestamp far outside allowed skew → rejected as "stale request."

---

## Program 3: Razorpay Test-Mode Integration Layer

Thin wrapper around Razorpay's test-mode Orders and Payments APIs. Only ever called by Program 2, after a pass decision — never reachable directly by an agent.

### 1) Architecture
- Holds the Razorpay test API key/secret (env vars, never hardcoded).
- Translates an internal purchase request into a Razorpay Order-creation payload.
- Receives Razorpay's webhook events (`order.paid`, `payment.failed`) and normalizes the result back to Programs 2 and 4.
- No business logic here — bounds/policy decisions have already happened in Program 2 by the time this layer is called.

### 2) Detailed features required
- `create_order(amount, currency, receipt_id, notes)` → calls Razorpay's Orders API, returns `order_id`.
- A test-mode "auto-pay" helper using Razorpay's documented test card/UPI credentials, so the full flow can run end-to-end in a demo without a human clicking through a checkout page manually.
- Webhook receiver: verifies Razorpay's webhook signature (HMAC with the webhook secret) before processing any event.
- Error mapping: Razorpay API errors → normalized internal error codes, so Program 4's log stays readable.
- Idempotency handling so a retried call can't double-charge.

### 3) Build guide
1. Get Razorpay test-mode API keys from the dashboard.
2. **Fetch Razorpay's current Orders API docs before writing any integration code** — don't rely on memorized field names, they drift over time.
3. Implement `create_order()` — `POST /v1/orders` with amount in paise, currency, receipt.
4. Implement the webhook endpoint, verifying the signature per Razorpay's documented scheme.
5. Implement the test-mode auto-pay helper for demo purposes.
6. Normalize all responses into `{status: success | failed, order_id, payment_id, raw_error}`.
7. Add retry/backoff for transient network errors only — never retry a genuine decline.

### 4) Test cases
- `create_order` with valid params → returns a real Razorpay test-mode `order_id`.
- `create_order` with invalid amount (zero/negative) → clean validation error, never reaches Razorpay.
- Simulated successful test payment → webhook fires `order.paid`, internal record updates to "completed."
- Simulated failed test payment (Razorpay's documented failure test cards) → webhook fires `payment.failed`, logged distinctly from a Gateway-side rejection — judges should be able to tell "we blocked it" apart from "the bank declined it."
- Webhook with an invalid/tampered signature → rejected, not processed.
- Duplicate webhook delivery (Razorpay does retry) → doesn't double-process.

---

## Program 4: Audit Log + UI

The paper trail, and the human's control panel.

### 1) Architecture
- Append-only log table — every Program 2 decision and every Program 3 terminal outcome gets written here.
- Simple read API + a lightweight single-page frontend.
- Doubles as the human's control panel: pending step-up approvals live here too, with approve/deny actions wired back to Program 2.

### 2) Detailed features required
- **Log entry fields**: timestamp, mandate_id, agent_id, request_amount, category, decision, reason, linked order_id/payment_id where applicable.
- **Append-only**: no updates or deletes — this is the actual substance of "audit trail," not just a UI label.
- **Pending-approvals panel**: shows step-up requests awaiting a human decision, one-click approve/deny.
- **Mandate overview panel**: active mandates with cap vs. current cumulative spend (a progress bar reads well in a demo).
- **Filter/search** by mandate_id, decision type, date range (nice-to-have, not essential).
- **Live-ish refresh**: simple polling so entries visibly appear during a live demo.

### 3) Build guide
1. Define the `audit_log` table/schema.
2. Implement `write_audit_entry()`, called from every decision branch in Program 2 and every terminal outcome in Program 3.
3. Build `GET /audit` (paginated, newest-first).
4. Build `GET /mandates/pending-approvals`.
5. Build the frontend: audit table, pending-approvals panel with approve/deny buttons, mandate summary with spend-vs-cap bars.
6. Wire polling (simple interval fetch) for a live-updating demo.
7. Color-code decisions (approved / step-up / rejected) so a judge can scan the whole log in seconds.

### 4) Test cases
- Every decision type from Program 2's test suite produces exactly one matching audit entry with the correct reason text.
- Attempting to modify or delete a past entry fails — genuinely append-only.
- A step-up request appears in the pending-approvals panel immediately after Program 2 creates it.
- Clicking "approve" resumes the flow correctly and a new audit entry appears.
- Clicking "deny" logs the denial and no order is created.
- After a batch of 10+ simulated agent requests (mix of approved / rejected / step-up), the log displays all of them in the correct order — this is your actual demo scene.

---

## Suggested build order across all four programs

1. Program 1 (Mandate Service) — nothing else works without it.
2. Program 4's schema + `write_audit_entry()` — build this early so every other program can log into it from day one, not bolted on at the end.
3. Program 2 (Verification Gateway) — the core logic.
4. Program 3 (Razorpay Integration) — wire in once the Gateway can already make pass/fail decisions.
5. Program 4's frontend — polish last, once there's real data flowing through to display.
