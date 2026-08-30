import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "./migrate";

export function createDb(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  migrate(db);
  return db;
}
