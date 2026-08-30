export class GatewayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayValidationError";
  }
}

export class PendingApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`Pending approval not found: ${id}`);
    this.name = "PendingApprovalNotFoundError";
  }
}
