import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const require = createRequire(import.meta.url);

export type SqliteDatabase = import("better-sqlite3").Database;
export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;

interface SqliteDatabaseConstructor {
  new (filename: string): SqliteDatabase;
}

export interface DatabaseHandle {
  sqlite: SqliteDatabase;
  db: AppDatabase;
  close(): void;
}

export function databasePath(stateDir: string): string {
  return join(stateDir, "devspace.sqlite");
}

export function openDatabase(stateDir: string): DatabaseHandle {
  mkdirSync(stateDir, { recursive: true });
  const Database = require("better-sqlite3") as SqliteDatabaseConstructor;
  const sqlite = new Database(databasePath(stateDir));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  return {
    sqlite,
    db: createDrizzleDatabase(sqlite),
    close: () => sqlite.close(),
  };
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
