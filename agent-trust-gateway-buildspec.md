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

**Important correction to the original design**: Razorpay's standard flow is not a pure server-to-server call end to end. `create_order()` is genuinely server-side, but the order_id must then be handed to Razorpay's Checkout widget to actually complete and capture the payment — a payment made without going through Checkout can't be captured and gets auto-refunded. Even in test mode, this means a mock bank page with Success/Failure buttons has to be "completed," not just an API response. For the demo, this gets automated with a headless browser rather than requiring an actual human to click anything.

### 1) Architecture
- Holds the Razorpay test API key/secret (env vars, never hardcoded).
- Translates an internal purchase request into a Razorpay Order-creation payload.
- **Headless checkout runner**: a Playwright (or Puppeteer) script that takes an order_id, loads a minimal page with Razorpay's Checkout.js pointed at that order, fills in Razorpay's documented test card/UPI credentials, and clicks "Success" on the mock bank page — invoked automatically, no human involved.
- Receives Razorpay's webhook events (`order.paid`, `payment.failed`) and normalizes the result back to Programs 2 and 4.
- No business logic here — bounds/policy decisions have already happened in Program 2 by the time this layer is called.

### 2) Detailed features required
- `create_order(amount, currency, receipt_id, notes)` → calls Razorpay's Orders API, returns `order_id`.
- **Headless checkout automation**: a script that drives Razorpay's actual Checkout.js flow programmatically using documented test credentials, so the demo shows a genuinely completed payment rather than a fabricated "success" status. Runs immediately after `create_order()` succeeds, on the pass path only.
- Webhook receiver: verifies Razorpay's webhook signature (HMAC with the webhook secret) before processing any event.
- Error mapping: Razorpay API errors → normalized internal error codes, so Program 4's log stays readable.
- Idempotency handling so a retried call can't double-charge.

### 3) Build guide
1. Get Razorpay test-mode API keys from the dashboard.
2. **Fetch Razorpay's current Orders API and Standard Checkout docs before writing any integration code** — don't rely on memorized field names or flow details, they drift over time.
3. Implement `create_order()` — `POST /v1/orders` with amount in paise, currency, receipt.
4. Build a minimal static HTML page that loads `checkout.js` against a given order_id — this is what the headless browser will drive.
5. Write the Playwright/Puppeteer script: launch headless, open the checkout page, select a payment method, fill Razorpay's documented test card or UPI credentials, submit, click "Success" on the mock bank page, wait for the redirect/callback.
6. Implement the webhook endpoint, verifying the signature per Razorpay's documented scheme.
7. Normalize all responses into `{status: success | failed, order_id, payment_id, raw_error}`.
8. Add retry/backoff for transient network errors only — never retry a genuine decline.
9. Time-box this: if the headless flow proves flaky or slow to get working, fall back to a clearly-labeled simulated payment step for the live demo, and note in the pitch that the Checkout automation works but was swapped for demo reliability.

### 4) Test cases
- `create_order` with valid params → returns a real Razorpay test-mode `order_id`.
- `create_order` with invalid amount (zero/negative) → clean validation error, never reaches Razorpay.
- Headless checkout run against a valid order with a successful test card → payment actually completes on Razorpay's side (verifiable in the Razorpay dashboard), webhook fires `order.paid`, internal record updates to "completed."
- Headless checkout run with Razorpay's documented failure test card → webhook fires `payment.failed`, logged distinctly from a Gateway-side rejection — judges should be able to tell "we blocked it" apart from "the bank declined it."
- Headless script times out or the checkout page fails to load → fails cleanly with a distinct error code, doesn't hang the request or silently mark it as paid.
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

## Program 5: Gemini-Powered Buyer Agent

The actual AI buyer. Replaces the "script that fires pre-written requests" with a real model making purchasing decisions — this is what makes the submission an *agentic commerce* project rather than a rules engine with a fixture attached.

**Why this exists**: Programs 1–4 contain zero model calls. They're infrastructure that *gates* an agent, not an agent. The track says "build an agent," and judges will look for a model actually reasoning somewhere in the demo. This program is that.

### 1) Architecture
- A Gemini tool-use (function-calling) loop, run as a standalone script/service.
- Given a **goal** in natural language ("restock weekly groceries", "top up the office snack supply under budget").
- Exposed **tools**: `browse_catalog(category)`, `submit_purchase(item, amount, category)`.
- `submit_purchase` does **not** talk to Razorpay directly — it signs the request with the agent's mandate keypair and calls Program 2, exactly like any external agent would. The Gateway treats it as untrusted input, same as anything else.
- Receives the Gateway's structured `{decision, reason}` back as a tool result, and must reason about what to do next (retry smaller, pick a different item, give up, wait for step-up approval).

### 2) Detailed features required
- **Goal-driven loop**: model decides *what* to buy and *how much* to spend, rather than executing a fixed list.
- **A mock merchant catalog** to browse — a static JSON list of items with names, prices, categories. Doesn't need to be real; needs to be varied enough that the agent has genuine choices to make.
- **Tool definitions** with clear schemas so the model calls them correctly.
- **Rejection handling**: when the Gateway returns `hard_fail` or `step_up`, the reason string goes back to the model and it must adapt. This is the most demo-valuable behavior in the whole project — an AI agent visibly hitting a wall and reasoning about it.
- **A deliberately over-budget goal** available for the demo (e.g. "buy a premium coffee machine" against a ₹500 grocery mandate) so the step-up flow triggers from genuine model behavior, not a hardcoded test.
- **Turn limit / stop condition** so the loop can't run away — cap iterations, and stop cleanly when the goal is met or the budget is exhausted.

### 3) Build guide
1. Build the mock catalog JSON (15–20 items across the category enum).
2. Define the two tool schemas (`browse_catalog`, `submit_purchase`).
3. Set up the Gemini API call with function declarations (tools) + a system instruction describing the agent's role and its mandate constraints. Check Gemini's current function-calling docs before implementing — parameter/schema conventions differ from other providers' tool-use formats, don't assume they match.
4. Implement `submit_purchase`'s handler: sign the request with the mandate keypair, POST to Program 2, return the structured decision to the model as a tool result.
5. Implement the loop: call model → execute tool → feed result back → repeat until goal met, budget exhausted, or turn cap hit.
6. Write 2–3 canned goals for the demo: one that succeeds cleanly, one that hits the cumulative cap and triggers step-up, one that tries an out-of-scope category and gets hard-failed.
7. Log the agent's reasoning alongside the audit trail so the demo can show *both* sides — what the agent thought, and what the Gateway decided.

### 4) Test cases
- Agent given an in-budget goal → completes purchases, all approved, audit trail matches.
- Agent given an out-of-scope goal (electronics against a groceries-only mandate) → Gateway hard-fails, agent receives the reason and doesn't blindly retry the identical request.
- Agent given a goal exceeding the cumulative cap → step-up triggered, agent waits/handles pending state gracefully rather than crashing or spamming retries.
- Agent hits the turn limit → stops cleanly, logs why.
- Agent attempts to bypass `submit_purchase` and call Razorpay directly → not possible; verify there's no code path exposing Program 3 to the agent.
- Malformed tool call from the model → handled without crashing the loop.

---

## Program 6: Bounded Upsell Agent (Groq-powered)

The revenue-growth half of the track. After a purchase is approved, an LLM call via the Groq API suggests one complementary item that fits within the mandate's *remaining* headroom — and that suggestion goes through the exact same bounds check before it can become a real order.

**Why this exists**: the track statement is "grows revenue for a merchant **or** makes a merchant transactable by an AI buyer." Programs 1–5 answer the second half. This answers the first, and does it in a way that's only possible *because* of the mandate system — the upsell is inherently budget-aware, which a normal recommendation engine can't be.

**Why Groq specifically**: this call sits on the critical path right after a payment succeeds and must not add noticeable latency to the demo — Groq's inference speed is the reason to pick it here over a slower provider for this one narrow, low-stakes call (one short suggestion, not multi-step reasoning). Pick a currently-available Groq-hosted model at build time rather than assuming a specific model name; check Groq's model list, since hosted models rotate.

### 1) Architecture
- Triggered by Program 2 after a `pass` decision and a successful Program 3 order.
- **Inputs**: the item just purchased, the mandate's category scope, and remaining headroom (`max_cumulative − current spend`, and `max_per_transaction`).
- **LLM call (Groq API)**: given those inputs plus the catalog, suggests one complementary item priced within the remaining headroom.
- **Output path**: the suggestion is surfaced to the buyer agent (Program 5) or the human via Program 4's UI — it is **never** auto-purchased. If accepted, it re-enters through Program 2's normal verification flow like any other request.

### 2) Detailed features required
- **Headroom calculation** passed explicitly to the model — don't rely on the model to do arithmetic on caps.
- **Hard filter before the LLM call**: pre-filter the catalog to items within remaining headroom *and* within the mandate's category scope, so the model can only choose from valid options. This is belt-and-braces — the Gateway would catch a bad suggestion anyway, but the model shouldn't be able to suggest something impossible in the first place.
- **One suggestion, not a list** — keeps the demo legible and avoids the model padding output.
- **Suggestion logged to the audit trail** as its own entry type (`upsell_suggested`), including whether it was accepted, declined, or ignored. This is what lets you report a measurable conversion number.
- **Never auto-purchases.** The suggestion is a proposal; acceptance is a fresh request through the Gateway. Non-negotiable — auto-purchasing on an upsell would break the entire "bounded and gated" premise the project rests on.
- **Graceful empty case**: if remaining headroom is too small for anything in scope, return no suggestion rather than forcing one.

### 3) Build guide
1. Add `upsell_suggested` / `upsell_accepted` / `upsell_declined` to the audit entry types.
2. Write the headroom calculator (pure function, easily testable).
3. Write the catalog pre-filter (in-scope categories ∩ affordable within headroom).
4. Build the Groq API call: system prompt + purchased item + filtered candidate list → one suggestion with a one-line reason. Set a tight timeout — if Groq's speed advantage isn't showing up, that's a signal something's wrong with the call, not a reason to wait longer.
5. Wire the trigger into Program 2's post-approval path — **asynchronously**, so a slow or failed LLM call never blocks or breaks the payment flow.
6. Surface the suggestion in Program 4's UI with accept/decline buttons.
7. On accept → construct a normal purchase request → route through Program 2 from the top, no shortcuts.
8. Track and display an upsell conversion metric (suggested vs. accepted, ₹ added) — this is your "grows revenue" evidence for the judges.

### 4) Test cases
- Purchase approved with healthy headroom → one in-scope, affordable suggestion returned and logged.
- Purchase approved with near-zero headroom → no suggestion returned, logged as such, no error.
- Suggested item accepted → routed through Program 2, verified again, order created, audit shows the full chain.
- Suggested item accepted *after* other spending consumed the headroom in between → correctly rejected/step-up at verification time, proving the upsell can't bypass bounds.
- LLM call fails or times out → original purchase is unaffected, flow continues, failure logged.
- Model returns an item outside scope or over headroom (force this with a deliberately broken prompt) → caught by the pre-filter and/or the Gateway, never becomes an order.
- Upsell conversion metric matches the audit log's suggested/accepted counts.

---

## Suggested build order across all six programs

1. Program 1 (Mandate Service) — nothing else works without it.
2. Program 4's schema + `write_audit_entry()` — build this early so every other program can log into it from day one, not bolted on at the end.
3. Program 2 (Verification Gateway) — the core logic.
4. Program 3 (Razorpay Integration) — wire in once the Gateway can already make pass/fail decisions.
5. Program 5 (Gemini-Powered Buyer Agent) — build before the frontend; it generates the realistic traffic the UI needs to display, and it's what proves the whole system works end to end.
6. Program 6 (Bounded Upsell Agent) — additive, sits on top of a working approval path.
7. Program 4's frontend — polish last, once real data is flowing through to display.

**If time runs short**: Program 6 is the one to cut. Programs 1–5 still constitute a complete answer to "makes a merchant transactable by an AI buyer end to end." Cutting Program 5 instead would leave you with infrastructure and no agent — don't.