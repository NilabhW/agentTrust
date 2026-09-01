# Agent Trust Gateway



Agent Trust Gateway lets a human set exact spending rules for an AI agent — how much, on what, per purchase, and in total — and enforces those rules on every single purchase attempt before any money moves. Every decision, whether allowed, blocked, or paused for human approval, is written to a permanent record nobody can edit or delete.

Built against Razorpay's test-mode payment APIs.

---

## The problem

AI agents are starting to do things on our behalf: reordering groceries, renewing subscriptions, buying stuff. To actually do that, an agent needs some way to pay.

The easy way to enable that — handing an agent a credit card number or a live payment API key — is also the dangerous way. There's no limit on how much it can spend, no restriction on what it can buy, and if something goes wrong (a bug, a bad instruction, a compromised agent) there's no fine-grained way to stop it or even know it happened until the statement arrives.

What's missing is a layer in between: something that knows the rules a human actually agreed to, checks every single purchase against those rules, and keeps a paper trail — the same way a company doesn't hand an employee an unlimited company card, it gives them an expense policy and someone who reviews unusual charges.

## The solution

Agent Trust Gateway is that layer. A human defines a **mandate** — a signed, tamper-evident record that says "this agent may spend up to ₹X per purchase and ₹Y in total, only on groceries and food delivery, until this date." Every purchase request the agent makes is checked against that mandate before it's allowed to reach Razorpay:

- **Within the rules** → the purchase goes through automatically.
- **Breaks a hard rule** (wrong category, expired or revoked mandate, tampered request) → blocked immediately, no exceptions.
- **Would exceed the spending budget** → paused and sent to a human for a one-click approve or deny, instead of just failing.

Every one of those outcomes — allowed, blocked, paused, approved, denied, timed out, paid, declined — is written to an append-only log. Nothing in that log can ever be edited or deleted, so it's a genuine audit trail, not just a debug log.

## How a purchase flows through the system

```
  Human                 AI Agent                 Verification Gateway              Razorpay
    |                       |                            |                            |
    |--- sets a mandate --->|                            |                            |
    |   (spending rules)    |                            |                            |
    |                       |--- signed purchase ------->|                            |
    |                       |    request                 |                            |
    |                       |                     checks signature,                   |
    |                       |                     checks it's not a                   |
    |                       |                     repeat request,                     |
    |                       |                     checks the rules                    |
    |                       |                            |                            |
    |                       |                     [within budget]------------------->|
    |                       |<---------- "approved" ------|<----- order created -------|
    |                       |                            |                            |
    |                       |                     [would exceed budget]               |
    |<----- approve/deny -- |<---- notifies human --------|                            |
    |       request         |                            |                            |
    |------- decision ----->|                            |                            |
    |                       |                     [if approved]-------------------->  |
    |                       |                            |                            |
    |                       |                            |<--- payment result --------|
    |                       |                            |    (webhook)               |
    |                       |                            |                            |
    |                       |                     every step logged, forever          |
```

## Architecture

The system is four components. They share one codebase (simplest for now) but are kept logically separate, so any one of them could become its own service later without a rewrite.

```
Human sets rules → Mandate Service (stores signed spending permissions)
        ↓
AI Agent → Verification Gateway ("the bouncer") → Razorpay Integration (test-mode payments)
        ↓                                    ↓
        └──────────► Audit Log + UI ◄────────┘
```

### 1. Mandate Service — the permission slip
Creates, stores, and revokes the spending rules ("mandates") a human sets for an agent: which categories it can buy in, the cap per purchase, the total budget, and an expiry date. Every mandate is cryptographically signed when it's created, so nobody — not even someone with direct database access — can quietly edit a mandate's limits without the tampering being detected the next time it's read. Also keeps a running total of how much each mandate has spent.

*Code: `src/mandate/`*

### 2. Verification Gateway 
The core of the system. Every purchase request from an agent passes through here first, and nothing reaches Razorpay without going through it. For each request it checks, in order:
1. **Is this really from the agent that owns this mandate?** (cryptographic signature check)
2. **Have we seen this exact request before?** (blocks replay/duplicate attacks)
3. **Is the mandate still active, not expired, not revoked?**
4. **Is this purchase within the category, per-purchase cap, and total budget the mandate allows?**

Based on those checks, it returns one of three outcomes: **pass** (goes through), **hard fail** (blocked, no exceptions — bad signature, wrong category, expired/revoked mandate), or **step-up** (would exceed the budget, so it's paused for a human to approve or deny, with an automatic denial if nobody responds in time).

*Code: `src/gateway/`*

### 3. Razorpay Integration — the payment layer
A thin wrapper around Razorpay's real test-mode payment APIs. It only ever gets called by the Verification Gateway, after a purchase has already been approved — it has no say in whether a purchase *should* happen, only in actually creating the order and later finding out whether the payment succeeded or failed (Razorpay reports this back via a webhook). Independently verifies that anything claiming to be a message from Razorpay really is one, using a cryptographic signature check, before trusting it.

*Code: `src/razorpay/`*

### 4. Audit Log + UI — the paper trail and control panel
Every decision the Gateway makes, and every outcome the Razorpay layer reports, gets written here — and once written, an entry can never be edited or deleted (enforced at the database level, not just by convention). Also serves the web dashboard: an overview of every mandate's spend vs. budget, the list of purchases currently waiting on a human, and the full timestamped log, color-coded so it's easy to scan.

*Code: `src/audit/`, `src/ui/`, `public/index.html`*

### A note on trust
The two places where trust actually gets established are both handled by cryptographic signatures, not by "the caller said so": a mandate's terms can't be silently altered after it's created, and a purchase request can't be forged by someone who doesn't hold the agent's private key. Three separate signature schemes are used for three separate trust relationships (mandate integrity, agent request authenticity, and Razorpay webhook authenticity) — kept deliberately separate rather than reused across purposes.

## Tech stack

- **Node.js + TypeScript**
- **Fastify** — HTTP server / API routes
- **better-sqlite3** — storage (SQLite; swappable for Postgres later without changing the design)
- **Vitest** — testing (256 automated tests, written before the code they test)

## Getting started

```bash
npm install
cp .env.example .env   # then fill in a signing key (and Razorpay test keys, if you have them)
npm run seed            # creates a few demo agents with real spending mandates
npm run dev              # starts the server on http://localhost:3000
```

Open `http://localhost:3000` for the dashboard — it includes a built-in "Simulate Agent Purchase" panel so you can try the whole flow without writing any code.

Razorpay's test-mode keys (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`) are optional. Without them, purchases are still fully checked against every rule — the only difference is that no real order gets created at the end.

## API overview

| Method | Path | What it does |
|---|---|---|
| `POST` | `/mandates` | Create a new spending mandate |
| `GET` | `/mandates` / `/mandates/:id` | List or fetch mandates |
| `POST` | `/mandates/:id/revoke` | Revoke a mandate immediately |
| `POST` | `/gateway/verify` | Submit a signed purchase request for checking |
| `GET` | `/gateway/pending-approvals` | List purchases waiting on a human |
| `POST` | `/gateway/pending-approvals/:id/approve` \| `/deny` | Resolve a paused purchase |
| `POST` | `/razorpay/webhook` | Receives payment results from Razorpay |
| `GET` | `/audit` | The full, paginated audit trail |

## Testing

```bash
npm test              # full suite
npm run typecheck
```

Every test case was written before the code that makes it pass. The suite covers the full range of decisions — normal purchases, invalid signatures, expired and revoked mandates, over-budget step-ups, human approval and denial, timeouts, replay attacks, and duplicate payment webhooks — not just the happy path.

## Known, accepted limitations

This is a hackathon-stage build, and a few gaps are deliberate, documented trade-offs rather than oversights:

- Creating a mandate has no authentication yet — anyone who can reach the service can mint one. A real deployment needs an operator-auth decision (sessions vs. API keys) that hasn't been made.
- The replay-protection cache (which blocks duplicate requests) lives in memory and resets on restart, and isn't shared across multiple server instances.
- If a purchase is approved but Razorpay's order-creation call itself then fails, the spending budget has already been debited even though no order exists — visible in the audit log, but not automatically reversed.

Full detail on these and how each was arrived at lives in `CLAUDE.md`.
