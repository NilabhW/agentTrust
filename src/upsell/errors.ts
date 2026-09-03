export class UpsellNotFoundError extends Error {
  constructor(id: string) {
    super(`Upsell not found: ${id}`);
    this.name = "UpsellNotFoundError";
  }
}
