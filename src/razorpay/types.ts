export interface CreateOrderInput {
  mandate_id: string;
  agent_id: string;
  amount: number;
  category: string;
  receipt: string;
  notes?: Record<string, string>;
}

export type CreateOrderResult =
  | { status: "success"; order_id: string; raw_error: null }
  | { status: "failed"; order_id: null; raw_error: string };

export type OrderStatus = "created" | "paid" | "failed";

export interface OrderRecord {
  order_id: string;
  mandate_id: string;
  agent_id: string;
  amount: number;
  currency: string;
  category: string;
  receipt: string;
  status: OrderStatus;
  created_at: number;
  updated_at: number;
  payment_id: string | null;
}

export type StoredOrderRow = OrderRecord;

export interface MarkOrderResult {
  order: OrderRecord;
  alreadyProcessed: boolean;
}

export type WebhookEventName = "order.paid" | "payment.failed";

export interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment?: {
      entity: {
        id: string;
        order_id: string | null;
        amount: number;
        status: string;
        error_code: string | null;
        error_description: string | null;
      };
    };
    order?: {
      entity: {
        id: string;
        amount: number;
        status: string;
      };
    };
  };
}
