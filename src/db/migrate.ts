import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function migrate(db: Database.Database): void {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
}
