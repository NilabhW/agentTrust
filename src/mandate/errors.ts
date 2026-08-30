export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class MandateNotFoundError extends Error {
  constructor(mandateId: string) {
    super(`Mandate not found: ${mandateId}`);
    this.name = "MandateNotFoundError";
  }
}

export class MandateIntegrityError extends Error {
  constructor(mandateId: string) {
    super(`Mandate signature verification failed: ${mandateId}`);
    this.name = "MandateIntegrityError";
  }
}
