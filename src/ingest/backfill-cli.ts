import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { openLocalDb, sqliteExecutor } from "./local-db";
import { WikiBlockedError, MediaWiki } from "./mediawiki";
import { backfillApiImages, backfillStoredImages } from "./backfill-images";
import { applySchema } from "./pipeline";
import { httpD1Executor, type CloudflareAuth } from "./remote";

const PLACEHOLDER_DB = "00000000-0000-0000-0000-000000000000";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function readConfig(): { databaseId: string } {
  const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  return { databaseId: /"database_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "" };
}

async function main(): Promise<void> {
  const targetName = arg("--target") ?? "local";
  const pageimages = has("--pageimages");
  if (targetName !== "local" && targetName !== "remote") throw new Error("--target must be local or remote");

  const sql =
    targetName === "local"
      ? sqliteExecutor(openLocalDb(arg("--out") ?? ".data/wiki.sqlite"))
      : await remoteSql();

  const stored = await backfillStoredImages(sql);
  let fromApi = 0;
  let blocked = false;
  if (pageimages) {
    const agent = new Agent({ allowH2: true, connect: { timeout: 20_000 } });
    const fetchImpl = async (input: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => {
      const options: UndiciRequestInit = { ...init, dispatcher: agent };
      return undiciFetch(input, options);
    };
    const wiki = new MediaWiki(fetchImpl, Number(arg("--pause-ms") ?? 100));
    try {
      const api = await backfillApiImages(sql, wiki);
      fromApi = api.fromApi;
    } catch (error) {
      if (!(error instanceof WikiBlockedError)) throw error;
      blocked = true;
      console.error(error.message);
    }
  }
  console.log(
    JSON.stringify({
      scanned: stored.scanned,
      fromStored: stored.fromStored,
      fromApi,
      stillMissing: Math.max(0, stored.stillMissing - fromApi),
    }),
  );
  if (blocked) process.exitCode = 1;
}

async function remoteSql() {
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
    indexName: "stardew-wiki",
  };
  if (auth.databaseId === PLACEHOLDER_DB) {
    throw new Error("Replace database_id in wrangler.jsonc (or set WIKI_DB_ID) before a remote backfill.");
  }
  const sql = httpD1Executor(auth);
  await applySchema(sql);
  return sql;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
