import { RazorpayValidationError } from "./errors";
import { CreateOrderInput, CreateOrderResult } from "./types";

type FetchImpl = typeof fetch;

export interface RazorpayClientOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.razorpay.com/v1";
// This call runs after incrementSpend() (see the safety-ordering comment in
// GatewayService.tryCreateOrder) -- an unbounded hang here would hold spend
// committed with the agent's HTTP request stuck open indefinitely. Bounding
// it turns a hang into a fast, normalized, auditable payment_failed entry.
const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeErrorBody(body: unknown, status: number): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "description" in body.error
  ) {
    return String((body.error as { description: unknown }).description);
  }
  return `Razorpay request failed with status ${status}`;
}

export class RazorpayClient {
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(opts: RazorpayClientOptions) {
    this.keyId = opts.keyId;
    this.keySecret = opts.keySecret;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new RazorpayValidationError("amount must be a positive finite number");
    }

    const amountPaise = Math.round(input.amount * 100);
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: "INR",
          receipt: input.receipt,
          notes: input.notes ?? {},
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      const orderId = body && typeof body === "object" && "id" in body ? (body as { id: unknown }).id : undefined;

      if (!response.ok || typeof orderId !== "string") {
        return { status: "failed", order_id: null, raw_error: normalizeErrorBody(body, response.status) };
      }

      return { status: "success", order_id: orderId, raw_error: null };
    } catch (err) {
      return {
        status: "failed",
        order_id: null,
        raw_error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
