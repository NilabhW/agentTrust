import { CATEGORIES, Category } from "../mandate/types";
import { GatewayValidationError } from "./errors";
import { VerifyRequestBody } from "./types";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function validateVerifyRequestBody(input: unknown): VerifyRequestBody {
  if (typeof input !== "object" || input === null) {
    throw new GatewayValidationError("Request body must be a JSON object");
  }
  const body = input as Record<string, unknown>;

  for (const field of ["mandate_id", "agent_signature", "item_description", "nonce"]) {
    if (!isNonEmptyString(body[field])) {
      throw new GatewayValidationError(`${field} is required and must be a non-empty string`);
    }
  }

  if (!isNonEmptyString(body.category) || !CATEGORIES.includes(body.category as Category)) {
    throw new GatewayValidationError(
      `category is required and must be one of: ${CATEGORIES.join(", ")}`
    );
  }

  if (!isPositiveFiniteNumber(body.amount)) {
    throw new GatewayValidationError("amount is required and must be a positive finite number");
  }

  if (!isPositiveInteger(body.timestamp)) {
    throw new GatewayValidationError("timestamp is required and must be a positive integer unix-epoch-ms value");
  }

  return {
    mandate_id: body.mandate_id as string,
    agent_signature: body.agent_signature as string,
    amount: body.amount as number,
    category: body.category as Category,
    item_description: body.item_description as string,
    timestamp: body.timestamp as number,
    nonce: body.nonce as string,
  };
}
