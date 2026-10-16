import { readEmbeddingMatrix } from "../wiki/embeddings";
import { EMBED_MODEL } from "../wiki/vectors";
import type { SqlExecutor, SqlParam } from "../wiki/index-store";

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
  };
}

async function d1Query(fetchImpl: typeof fetch, auth: CloudflareAuth, sql: string, params: SqlParam[]): Promise<unknown[]> {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/d1/database/${auth.databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const payload = (await response.json()) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: Array<{ results?: unknown[] }>;
  };
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.[0]?.message || `d1 http ${response.status}`;
    throw new Error(message);
  }
  return payload.result?.[0]?.results ?? [];
}

export async function embedRemote(auth: CloudflareAuth, texts: string[]): Promise<number[][]> {
  const fetchImpl = auth.fetchImpl ?? fetch;
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
    const message = payload.errors?.[0]?.message || `ai http ${response.status}`;
    throw new Error(message);
  }
  return readEmbeddingMatrix(payload);
}

export async function upsertRemoteVector(
  auth: CloudflareAuth,
  id: string,
  values: number[],
  metadata: { lang: string; title: string },
): Promise<void> {
  const fetchImpl = auth.fetchImpl ?? fetch;
  const line = JSON.stringify({ id, values, metadata });
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/vectorize/v2/indexes/${auth.indexName}/upsert`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/x-ndjson",
      },
      body: `${line}\n`,
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`vectorize http ${response.status}: ${text.slice(0, 180)}`);
  }
}
