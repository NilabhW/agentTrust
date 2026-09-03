import { randomUUID } from "node:crypto";
import { AuditStore } from "../audit/store";
import { GatewayService } from "../gateway/service";
import { signAgentRequest, AgentSignedPayload } from "../gateway/agent-signature";
import { Category } from "../mandate/types";
import { loadDemoKeys } from "../demo/keys";
import { calculateHeadroom, filterCandidates } from "./headroom";
import { UpsellStore } from "./store";
import { UpsellNotFoundError } from "./errors";
import { SuggestUpsellInput, UpsellMetrics } from "./types";

export interface ChatCompletionLike {
  chatCompletion(input: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    jsonMode?: boolean;
    maxTokens?: number;
  }): Promise<{ status: "success"; content: string } | { status: "failed"; raw_error: string }>;
}

export interface AcceptResult {
  httpStatus: number;
  result: unknown;
}

const SYSTEM_PROMPT =
  "You are a merchant's upsell assistant. You will be given the item a customer just bought and a short list " +
  "of candidate items they could also add to their order -- every candidate is already confirmed to be in-scope " +
  "and affordable, so you do not need to check price or category yourself. Pick exactly ONE candidate that " +
  "genuinely complements the purchased item, and respond with ONLY a JSON object of the shape " +
  '{"item_id": "<the chosen candidate\'s id>", "reason": "<one short sentence>"}. ' +
  "Do not pick anything outside the candidate list.";

// purchasedItemName comes from an agent-signed request field
// (item_description) that's validated only as "non-empty string" -- an
// agent legitimately controls it, and it's interpolated into a prompt whose
// output (reason) a human operator reads next to an Accept button. Strip
// newlines/control characters and cap the length before it ever reaches
// Groq, and independently cap what Groq returns before it's ever persisted
// or displayed -- neither is a sufficient trust boundary on its own.
const MAX_PROMPT_ITEM_LENGTH = 120;
const MAX_REASON_LENGTH = 200;
const MAX_RESPONSE_TOKENS = 150;

function sanitizeForPrompt(value: string, maxLength: number): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export class UpsellService {
  constructor(
    private readonly upsellStore: UpsellStore,
    private readonly auditStore: AuditStore,
    private readonly groqClient: ChatCompletionLike,
    private readonly gatewayService: GatewayService,
    private readonly demoKeysPath: string
  ) {}

  async suggestUpsell(input: SuggestUpsellInput, now: number = Date.now()): Promise<void> {
    const headroom = calculateHeadroom(input.mandate);
    const candidates = filterCandidates({ allowedCategories: input.mandate.category, headroom });
    if (candidates.length === 0) return;

    const purchasedItemName = input.purchasedItemName
      ? sanitizeForPrompt(input.purchasedItemName, MAX_PROMPT_ITEM_LENGTH)
      : "(not specified)";
    const userPrompt =
      `Purchased item: ${purchasedItemName}\n` +
      `Candidates:\n` +
      candidates.map((item) => `- id: ${item.id}, name: ${item.name}, price_inr: ${item.price_inr}`).join("\n");

    const result = await this.groqClient.chatCompletion({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      jsonMode: true,
      maxTokens: MAX_RESPONSE_TOKENS,
    });

    if (result.status === "failed") return;

    let parsed: { item_id?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(result.content);
    } catch {
      return;
    }

    if (typeof parsed.item_id !== "string") return;
    const chosen = candidates.find((item) => item.id === parsed.item_id);
    if (!chosen) return; // defense-in-depth: a hallucinated or out-of-set pick is silently dropped

    const rawReason =
      typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "Pairs well with your purchase.";
    const reason = sanitizeForPrompt(rawReason, MAX_REASON_LENGTH);

    // Write the audit entry before persisting the upsells row, not after:
    // if the write fails (e.g. a schema mismatch on a not-yet-migrated
    // database -- exactly what happened here during review), this ordering
    // means no live, actionable row is ever left behind with zero audit
    // trail. The whole block is swallowed -- this function is fire-and-
    // forget from the Gateway's perspective (see gateway/service.ts's
    // tryCreateOrder) and must never throw regardless of the reason.
    try {
      this.auditStore.writeEntry({
        mandate_id: input.mandate.mandate_id,
        agent_id: input.mandate.agent_id,
        request_amount: chosen.price_inr,
        category: chosen.category,
        decision: "upsell_suggested",
        reason,
        order_id: input.originOrderId ?? null,
        created_at: now,
      });

      this.upsellStore.create(
        {
          mandate_id: input.mandate.mandate_id,
          agent_id: input.mandate.agent_id,
          origin_order_id: input.originOrderId ?? null,
          item_id: chosen.id,
          item_name: chosen.name,
          category: chosen.category,
          amount: chosen.price_inr,
          reason,
        },
        now
      );
    } catch {
      return;
    }
  }

  async accept(id: string, now: number = Date.now()): Promise<AcceptResult> {
    const current = this.upsellStore.getById(id);
    if (!current) throw new UpsellNotFoundError(id);
    if (current.status !== "suggested") {
      return { httpStatus: 409, result: current };
    }

    const demoKeys = loadDemoKeys(this.demoKeysPath);
    const entry = demoKeys?.[current.mandate_id];
    if (!entry) {
      return {
        httpStatus: 400,
        result: { error: `No demo key found for mandate ${current.mandate_id}. Run \`npm run seed\` first.` },
      };
    }

    const resolved = this.upsellStore.accept(id, now);
    if (resolved.alreadyResolved) {
      return { httpStatus: 409, result: resolved.upsell };
    }

    this.auditStore.writeEntry({
      mandate_id: resolved.upsell.mandate_id,
      agent_id: resolved.upsell.agent_id,
      request_amount: resolved.upsell.amount,
      category: resolved.upsell.category,
      decision: "upsell_accepted",
      reason: `Accepted upsell: ${resolved.upsell.item_name}`,
      created_at: now,
    });

    // Route through the Gateway from the top, no shortcuts -- a completely
    // fresh, independent bounds check against current mandate state. If
    // spend happened between suggestion and acceptance, this is where it
    // gets caught for real.
    const payload: AgentSignedPayload = {
      mandate_id: resolved.upsell.mandate_id,
      amount: resolved.upsell.amount,
      category: resolved.upsell.category as Category,
      item_description: resolved.upsell.item_name,
      timestamp: now,
      nonce: randomUUID(),
    };
    const agent_signature = signAgentRequest(payload, entry.privateKeyJwk);
    const { pending_approval_id: _internalOnly, ...verifyResult } = await this.gatewayService.verify(
      { ...payload, agent_signature },
      now
    );

    return { httpStatus: 200, result: verifyResult };
  }

  decline(id: string, now: number = Date.now()): { httpStatus: number; result: unknown } {
    const current = this.upsellStore.getById(id);
    if (!current) throw new UpsellNotFoundError(id);

    const resolved = this.upsellStore.decline(id, now);
    if (resolved.alreadyResolved) {
      return { httpStatus: 409, result: resolved.upsell };
    }

    this.auditStore.writeEntry({
      mandate_id: resolved.upsell.mandate_id,
      agent_id: resolved.upsell.agent_id,
      request_amount: resolved.upsell.amount,
      category: resolved.upsell.category,
      decision: "upsell_declined",
      reason: `Declined upsell: ${resolved.upsell.item_name}`,
      created_at: now,
    });

    return { httpStatus: 200, result: resolved.upsell };
  }

  listPending() {
    return this.upsellStore.listPending();
  }

  metrics(): UpsellMetrics {
    return this.upsellStore.metrics();
  }
}
