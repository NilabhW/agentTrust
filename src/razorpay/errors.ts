export class RazorpayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayValidationError";
  }
}

export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order not found: ${orderId}`);
    this.name = "OrderNotFoundError";
  }
}
