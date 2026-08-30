import { AuditValidationError } from "./errors";
import { DECISIONS, Decision, ListAuditEntriesOptions } from "./types";

const DEFAULT_LIMIT = 50;

function parsePositiveInt(value: string, fieldName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new AuditValidationError(`${fieldName} must be a positive integer`);
  }
  const parsed = Number(value);
  if (parsed <= 0) {
    throw new AuditValidationError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

export function parseListAuditQuery(query: Record<string, unknown>): ListAuditEntriesOptions {
  const result: ListAuditEntriesOptions = { limit: DEFAULT_LIMIT };

  if (query.limit !== undefined) {
    result.limit = parsePositiveInt(String(query.limit), "limit");
  }

  if (query.before_id !== undefined) {
    result.before_id = parsePositiveInt(String(query.before_id), "before_id");
  }

  if (query.mandate_id !== undefined) {
    result.mandate_id = String(query.mandate_id);
  }

  if (query.decision !== undefined) {
    const decision = String(query.decision);
    if (!DECISIONS.includes(decision as Decision)) {
      throw new AuditValidationError(`decision must be one of: ${DECISIONS.join(", ")}`);
    }
    result.decision = decision as Decision;
  }

  return result;
}
