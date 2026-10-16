import type { SqlExecutor, SqlParam } from "../wiki/index-store";

export function d1Executor(db: D1Database): SqlExecutor {
  return {
    async all<T>(sql: string, params: SqlParam[]): Promise<T[]> {
      const statement = params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);
      const result = await statement.all<T>();
      return result.results;
    },
    async run(sql: string, params: SqlParam[]): Promise<void> {
      const statement = params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);
      await statement.run();
    },
  };
}
