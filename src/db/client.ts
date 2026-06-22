import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateDatabase } from "./migrations.js";
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
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodIfSupported(stateDir, 0o700);

  const dbPath = databasePath(stateDir);
  const Database = require("better-sqlite3") as SqliteDatabaseConstructor;
  const sqlite = new Database(dbPath);
  chmodIfSupported(dbPath, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  migrateDatabase(sqlite);

  return {
    sqlite,
    db: createDrizzleDatabase(sqlite),
    close: () => sqlite.close(),
  };
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}

function chmodIfSupported(path: string, mode: number): void {
  if (process.platform === "win32") return;
  chmodSync(path, mode);
}
