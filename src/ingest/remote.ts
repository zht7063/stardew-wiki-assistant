import { readEmbeddingMatrix } from "../wiki/embeddings";
import { EMBED_MODEL } from "../wiki/vectors";
import type { SqlExecutor, SqlParam, SqlStatement } from "../wiki/index-store";
import { isRetryableStatus, withBackoff } from "./retry";

export interface CloudflareAuth {
  accountId: string;
  token: string;
  databaseId: string;
  indexName: string;
  fetchImpl?: typeof fetch;
}

const PLACEHOLDER_DB = "00000000-0000-0000-0000-000000000000";

export function httpD1Executor(auth: CloudflareAuth): SqlExecutor {
  if (!auth.databaseId || auth.databaseId === PLACEHOLDER_DB) {
    throw new Error("Set d1_databases[0].database_id in wrangler.jsonc to the id printed by `wrangler d1 create stardew-wiki`.");
  }
  const fetchImpl = auth.fetchImpl ?? fetch;
  return {
    async all<T>(sql: string, params: SqlParam[]): Promise<T[]> {
      const body = await d1Query(fetchImpl, auth, sql, params);
      return body as T[];
    },
    async run(sql: string, params: SqlParam[]): Promise<void> {
      await d1Query(fetchImpl, auth, sql, params);
    },
    async batch(statements: SqlStatement[]): Promise<void> {
      await d1Batch(fetchImpl, auth, statements);
    },
  };
}

async function d1Query(fetchImpl: typeof fetch, auth: CloudflareAuth, sql: string, params: SqlParam[]): Promise<unknown[]> {
  return withBackoff(async () => {
    const payload = await postD1(fetchImpl, auth, { sql, params });
    return payload.result?.[0]?.results ?? [];
  });
}

async function d1Batch(fetchImpl: typeof fetch, auth: CloudflareAuth, statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;
  await withBackoff(async () => {
    const payload = await postD1(fetchImpl, auth, { batch: statements });
    for (const row of payload.result ?? []) {
      if (row && row.success === false) throw new Error("d1 http 500: a batched statement failed");
    }
  });
}

async function postD1(
  fetchImpl: typeof fetch,
  auth: CloudflareAuth,
  body: { sql: string; params: SqlParam[] } | { batch: SqlStatement[] },
): Promise<{ result?: Array<{ results?: unknown[]; success?: boolean }> }> {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/d1/database/${auth.databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const payload = (await response.json()) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: Array<{ results?: unknown[]; success?: boolean }>;
  };
  if (!response.ok || payload.success === false) {
    const detail = payload.errors?.[0]?.message || "d1 query failed";
    const status = isRetryableStatus(response.status) ? response.status : response.status || 400;
    throw new Error(`d1 http ${status}: ${detail}`);
  }
  return payload;
}

export async function embedRemote(auth: CloudflareAuth, texts: string[]): Promise<number[][]> {
  const fetchImpl = auth.fetchImpl ?? fetch;
  return withBackoff(async () => {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/ai/run/${EMBED_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: texts }),
      },
    );
    const payload = (await response.json()) as { success?: boolean; errors?: Array<{ message?: string }> };
    if (!response.ok || payload.success === false) {
      const detail = payload.errors?.[0]?.message || "ai run failed";
      throw new Error(`ai http ${response.status}: ${detail}`);
    }
    return readEmbeddingMatrix(payload);
  });
}

export interface RemoteVector {
  id: string;
  values: number[];
  metadata: { lang: string; title: string };
}

export async function upsertRemoteVectors(auth: CloudflareAuth, items: RemoteVector[]): Promise<void> {
  if (items.length === 0) return;
  const fetchImpl = auth.fetchImpl ?? fetch;
  const body = `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
  await withBackoff(async () => {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/vectorize/v2/indexes/${auth.indexName}/upsert`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/x-ndjson",
        },
        body,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`vectorize http ${response.status}: ${text.slice(0, 180)}`);
    }
  });
}
