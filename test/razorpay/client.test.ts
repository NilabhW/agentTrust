import { describe, expect, it, vi } from "vitest";
import { RazorpayClient } from "../../src/razorpay/client";
import { RazorpayValidationError } from "../../src/razorpay/errors";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const baseInput = {
  mandate_id: "mandate-1",
  agent_id: "agent-1",
  category: "groceries",
  receipt: "mandate-1-nonce-1",
};

describe("RazorpayClient.createOrder", () => {
  it("returns a normalized success result on a valid request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "order_test123", status: "created" })
    );
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    const result = await client.createOrder({ ...baseInput, amount: 450 });

    expect(result).toEqual({ status: "success", order_id: "order_test123", raw_error: null });
  });

  it("converts a whole-rupee amount to integer paise", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_x" }));
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    await client.createOrder({ ...baseInput, amount: 450 });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.amount).toBe(45000);
    expect(sentBody.currency).toBe("INR");
  });

  it("converts a fractional-rupee amount to integer paise", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_x" }));
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    await client.createOrder({ ...baseInput, amount: 199.5 });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.amount).toBe(19950);
  });

  it("sends Basic Auth using the configured key id/secret", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_x" }));
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    await client.createOrder({ ...baseInput, amount: 100 });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const expected = `Basic ${Buffer.from("key_id:key_secret").toString("base64")}`;
    expect(requestInit.headers.Authorization).toBe(expected);
  });

  it("rejects a zero amount before ever calling fetch", async () => {
    const fetchImpl = vi.fn();
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    await expect(client.createOrder({ ...baseInput, amount: 0 })).rejects.toThrow(RazorpayValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a negative amount before ever calling fetch", async () => {
    const fetchImpl = vi.fn();
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    await expect(client.createOrder({ ...baseInput, amount: -50 })).rejects.toThrow(RazorpayValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes a Razorpay 4xx error response into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, { error: { code: "BAD_REQUEST_ERROR", description: "receipt already used" } })
    );
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    const result = await client.createOrder({ ...baseInput, amount: 100 });

    expect(result.status).toBe("failed");
    expect(result.order_id).toBeNull();
    expect(result.raw_error).toContain("receipt already used");
  });

  it("normalizes a network failure into a failed result instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    const result = await client.createOrder({ ...baseInput, amount: 100 });

    expect(result).toEqual({ status: "failed", order_id: null, raw_error: "ECONNREFUSED" });
  });

  it("attaches an AbortSignal to the fetch call so a hang can be bounded", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_x" }));
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    await client.createOrder({ ...baseInput, amount: 100 });

    const [, requestInit] = fetchImpl.mock.calls[0];
    expect(requestInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves as a normalized failure instead of hanging forever when the request times out", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, requestInit: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        requestInit.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    });
    const client = new RazorpayClient({
      keyId: "key_id",
      keySecret: "key_secret",
      fetchImpl,
      timeoutMs: 20,
    });

    const result = await client.createOrder({ ...baseInput, amount: 100 });

    expect(result.status).toBe("failed");
    expect(result.order_id).toBeNull();
  });

  it("normalizes an unparseable response body into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });
    const client = new RazorpayClient({ keyId: "key_id", keySecret: "key_secret", fetchImpl });

    const result = await client.createOrder({ ...baseInput, amount: 100 });

    expect(result.status).toBe("failed");
    expect(result.order_id).toBeNull();
  });
});
