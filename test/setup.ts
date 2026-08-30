import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate";

export const TEST_SIGNING_KEY = "test-signing-key-do-not-use-in-prod";

export function buildTestDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}
