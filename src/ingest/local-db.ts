import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlExecutor, SqlParam, SqlStatement } from "../wiki/index-store";
import { SCHEMA_SQL } from "../wiki/schema";

export function openLocalDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  return db;
}

export function sqliteExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all<T>(sql: string, params: SqlParam[]): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlParam[]): Promise<void> {
      db.prepare(sql).run(...params);
    },
    async batch(statements: SqlStatement[]): Promise<void> {
      db.exec("BEGIN");
      try {
        for (const statement of statements) db.prepare(statement.sql).run(...statement.params);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
