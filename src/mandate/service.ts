import { validateCreateMandateInput } from "./validation";
import { MandateStore } from "./store";
import { Mandate } from "./types";

export class MandateService {
  constructor(private readonly store: MandateStore) {}

  create(input: unknown): Mandate {
    const validated = validateCreateMandateInput(input);
    return this.store.create(validated);
  }

  revoke(mandateId: string): void {
    this.store.revoke(mandateId);
  }

  getById(mandateId: string): Mandate {
    return this.store.getById(mandateId);
  }

  listByUser(userId: string): Mandate[] {
    return this.store.listByUser(userId);
  }
}
