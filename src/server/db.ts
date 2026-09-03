import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate } from "./schema";

export function assertBetterSqliteAvailable(): void {
  try {
    const memory = new Database(":memory:");
    memory.prepare("SELECT 1 AS ok").get();
    memory.close();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DuckGraph could not load better-sqlite3. Run npm install again for this platform. Detail: ${detail}`,
      { cause: error }
    );
  }
}

export function openDuckDatabase(dbPath: string): Database.Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  assertBetterSqliteAvailable();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
