import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import type { WikiLang } from "../shared/types";
import { openLocalDb, sqliteExecutor } from "./local-db";
import { MediaWiki } from "./mediawiki";
import { applySchema, ingestWiki, targetFromSql } from "./pipeline";
import { embedRemote, httpD1Executor, upsertRemoteVectors, type CloudflareAuth } from "./remote";

const PLACEHOLDER_DB = "00000000-0000-0000-0000-000000000000";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function readConfig(): { databaseId: string; indexName: string } {
  const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  const databaseId = /"database_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "";
  const indexName = /"index_name"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "stardew-wiki";
  return { databaseId, indexName };
}

async function main(): Promise<void> {
  const targetName = arg("--target") ?? "local";
  const limitRaw = arg("--limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) throw new Error("--limit must be a positive number");
  const langs = (arg("--langs") ?? "zh,en")
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is WikiLang => part === "zh" || part === "en");
  if (langs.length === 0) throw new Error("--langs must include zh and/or en");
  const skipVectors = has("--skip-vectors") || targetName === "local";
  const pauseMs = Number(arg("--pause-ms") ?? 100);
  const concurrency = Math.min(4, Math.max(1, Number(arg("--concurrency") ?? 3) || 3));
  if (!Number.isFinite(pauseMs) || pauseMs < 0) throw new Error("--pause-ms must be a non-negative number");

  const agent = new Agent({ allowH2: true, connect: { timeout: 20_000 } });
  const fetchImpl = async (input: string, init?: { headers?: Record<string, string> }) => {
    const options: UndiciRequestInit = { dispatcher: agent, headers: init?.headers };
    return undiciFetch(input, options);
  };
  const wiki = new MediaWiki(fetchImpl, pauseMs, { concurrency });

  let target = targetFromSql(sqliteExecutor(openLocalDb(arg("--out") ?? ".data/wiki.sqlite")));
  if (targetName === "remote") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    if (!accountId || !token) {
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. See the README for the token permissions.");
    }
    const config = readConfig();
    const auth: CloudflareAuth = {
      accountId,
      token,
      databaseId: process.env.WIKI_DB_ID || config.databaseId,
      indexName: process.env.VECTORIZE_INDEX || config.indexName,
    };
    if (auth.databaseId === PLACEHOLDER_DB) {
      throw new Error("Replace database_id in wrangler.jsonc (or set WIKI_DB_ID) before a remote ingest.");
    }
    const sql = httpD1Executor(auth);
    await applySchema(sql);
    const base = targetFromSql(sql);
    target = {
      ...base,
      putVectors: skipVectors ? undefined : (items) => upsertRemoteVectors(auth, items),
    };
    const stats = await ingestWiki({
      wiki,
      target,
      langs,
      limit,
      concurrency,
      embed: skipVectors ? undefined : (texts) => embedRemote(auth, texts),
      onProgress: (message) => console.log(message),
    });
    console.log(JSON.stringify(stats));
    return;
  }
  if (targetName !== "local") throw new Error("--target must be local or remote");
  const stats = await ingestWiki({
    wiki,
    target,
    langs,
    limit,
    concurrency,
    onProgress: (message) => console.log(message),
  });
  console.log(JSON.stringify(stats));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
