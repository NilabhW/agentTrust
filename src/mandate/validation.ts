import { CATEGORIES, Category, CreateMandateInput } from "./types";
import { ValidationError } from "./errors";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function validateCreateMandateInput(input: unknown): CreateMandateInput {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const body = input as Record<string, unknown>;

  for (const field of ["user_id", "agent_id", "agent_public_key"]) {
    if (!isNonEmptyString(body[field])) {
      throw new ValidationError(`${field} is required and must be a non-empty string`);
    }
  }

  if (!Array.isArray(body.category) || body.category.length === 0) {
    throw new ValidationError("category is required and must be a non-empty array");
  }
  const category = Array.from(new Set(body.category)) as unknown[];
  for (const value of category) {
    if (!CATEGORIES.includes(value as Category)) {
      throw new ValidationError(
        `category contains an invalid value: ${String(value)}. Allowed values: ${CATEGORIES.join(", ")}`
      );
    }
  }

  if (!isPositiveFiniteNumber(body.max_per_transaction)) {
    throw new ValidationError("max_per_transaction is required and must be a positive finite number");
  }
  if (!isPositiveFiniteNumber(body.max_cumulative)) {
    throw new ValidationError("max_cumulative is required and must be a positive finite number");
  }
  if (!isPositiveInteger(body.rolling_window_seconds)) {
    throw new ValidationError("rolling_window_seconds is required and must be a positive integer");
  }
  if (!isPositiveFiniteNumber(body.expires_at)) {
    throw new ValidationError("expires_at is required and must be a positive finite unix-epoch-ms timestamp");
  }

  return {
    user_id: body.user_id as string,
    agent_id: body.agent_id as string,
    agent_public_key: body.agent_public_key as string,
    category: category as Category[],
    max_per_transaction: body.max_per_transaction as number,
    max_cumulative: body.max_cumulative as number,
    rolling_window_seconds: body.rolling_window_seconds as number,
    expires_at: body.expires_at as number,
  };
}
