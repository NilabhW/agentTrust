import { AuditStore } from "./store";
import { ListAuditEntriesOptions, ListAuditEntriesResult } from "./types";

export class AuditService {
  constructor(private readonly store: AuditStore) {}

  list(options: ListAuditEntriesOptions): ListAuditEntriesResult {
    return this.store.list(options);
  }
}
