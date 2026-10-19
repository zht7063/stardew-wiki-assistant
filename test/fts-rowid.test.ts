import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteExecutor } from "../src/ingest/local-db";
import { MediaWiki } from "../src/ingest/mediawiki";
import { applySchema, ensureFtsRowidSchema, ingestWiki, targetFromSql } from "../src/ingest/pipeline";
import { upsertStoredPage, WikiIndex } from "../src/wiki/index-store";
import { FTS_ROWID_MIGRATION_STATEMENTS } from "../src/wiki/schema";
import type { StoredPage } from "../src/wiki/record";

function norm(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function page(title: string, searchText: string): StoredPage {
  return {
    lang: "zh",
    title,
    url: `https://zh.stardewvalleywiki.com/${title}`,
    revId: 1,
    infobox: [],
    sections: [],
    searchText,
    body: searchText,
    truncated: false,
  };
}

/** Schema as it was before migration 0002: no content_hash, FTS rowids unrelated to pages. */
function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE pages (
    lang TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, rev_id INTEGER NOT NULL DEFAULT 0,
    counterpart_lang TEXT, counterpart_title TEXT, counterpart_url TEXT,
    infobox_json TEXT NOT NULL DEFAULT '[]', sections_json TEXT NOT NULL DEFAULT '[]',
    search_text TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', image_url TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (lang, title)
  );
  CREATE VIRTUAL TABLE pages_fts USING fts5(title, search_text, lang UNINDEXED, tokenize = 'trigram case_sensitive 0');`);
  const insert = db.prepare(
    `INSERT INTO pages (lang, title, url, rev_id, search_text, body, updated_at) VALUES ('zh', ?, ?, 1, ?, ?, 1)`,
  );
  const fts = db.prepare(`INSERT INTO pages_fts (rowid, title, search_text, lang) VALUES (?, ?, ?, 'zh')`);
  ["草莓", "蓝莓", "防风草"].forEach((title, index) => {
    insert.run(title, `https://zh.stardewvalleywiki.com/${title}`, `${title}是一种作物`, `${title}是一种作物`);
    fts.run(100 + index, title, `${title}是一种作物`);
  });
  // A stale duplicate left by the old delete-by-title path.
  fts.run(200, "草莓", "草莓是一种作物");
  return db;
}

describe("pages_fts keyed by pages.rowid", () => {
  it("keeps the migration file in sync with the statements local ingest applies", () => {
    const file = readFileSync(new URL("../schema/migrations/0002_fts_rowid_content_hash.sql", import.meta.url), "utf8");
    expect(norm(file)).toBe(norm(FTS_ROWID_MIGRATION_STATEMENTS.join(";\n")));
  });

  it("refuses a remote-style ingest until migration 0002 is applied", async () => {
    const sql = sqliteExecutor(legacyDb());
    await applySchema(sql);
    await expect(ensureFtsRowidSchema(sql, "require")).rejects.toThrow(/0002_fts_rowid_content_hash\.sql/);
  });

  it("migrates a legacy database, then re-ingests by rowid without duplicates", async () => {
    const db = legacyDb();
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    await ensureFtsRowidSchema(sql, "migrate");
    await ensureFtsRowidSchema(sql, "require");
    const mismatched = db
      .prepare(`SELECT count(*) AS n FROM pages_fts f LEFT JOIN pages p ON p.rowid = f.rowid WHERE p.title IS NOT f.title`)
      .get() as { n: number };
    expect(mismatched.n).toBe(0);
    expect((db.prepare(`SELECT count(*) AS n FROM pages_fts`).get() as { n: number }).n).toBe(3);

    await upsertStoredPage(sql, page("草莓", "草莓是春季作物，夏季不能种"));
    await upsertStoredPage(sql, page("草莓", "草莓是春季作物，售价很高"));
    await upsertStoredPage(sql, page("甜瓜", "甜瓜是夏季作物"));
    const rows = db.prepare(`SELECT rowid, title, search_text FROM pages_fts WHERE title = '草莓'`).all() as Array<{
      rowid: number;
      search_text: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.search_text).toContain("售价很高");
    const pageRow = db.prepare(`SELECT rowid FROM pages WHERE lang = 'zh' AND title = '草莓'`).get() as { rowid: number };
    expect(rows[0]?.rowid).toBe(pageRow.rowid);
    expect((db.prepare(`SELECT count(*) AS n FROM pages_fts`).get() as { n: number }).n).toBe(4);

    const found = await new WikiIndex(sql).search("售价很高", "zh");
    expect(found.results[0]?.title).toBe("草莓");
    const melon = await new WikiIndex(sql).search("夏季作物", "zh");
    expect(melon.results.map((hit) => hit.title)).toContain("甜瓜");
  });

  it("deletes FTS rows with a rowid lookup, not a table scan", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE pages (lang TEXT NOT NULL, title TEXT NOT NULL, PRIMARY KEY (lang, title));
      CREATE VIRTUAL TABLE pages_fts USING fts5(title, search_text, lang UNINDEXED, tokenize = 'trigram case_sensitive 0');`);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM pages_fts WHERE rowid = (SELECT rowid FROM pages WHERE lang = 'zh' AND title = 'x')`,
      )
      .all() as Array<{ detail: string }>;
    // FTS5 index 0 with "=" is its rowid lookup; a plain scan shows "INDEX 0:" with nothing after it.
    expect(plan.map((row) => row.detail).join("\n")).toMatch(/VIRTUAL TABLE INDEX 0:=/);
  });

  it("skips the write when a new revision renders the same content", async () => {
    let rev = 1;
    let text = "<p>防风草是春季作物。</p>";
    let parses = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      url.search = String(init?.body ?? "");
      if (url.searchParams.get("list") === "allpages") return Response.json({ query: { allpages: [{ title: "防风草" }] } });
      if (url.searchParams.get("prop")?.includes("langlinks")) {
        return Response.json({ query: { pages: [{ title: "防风草", lastrevid: rev, langlinks: [] }] } });
      }
      parses += 1;
      return Response.json({ parse: { title: "防风草", text } });
    };
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    const wiki = new MediaWiki(fetchImpl, 0);
    const embedded: string[][] = [];
    const target = { ...targetFromSql(sql), putVectors: async () => undefined };
    const embed = async (texts: string[]) => {
      embedded.push(texts);
      return texts.map(() => [0.1, 0.2]);
    };
    expect((await ingestWiki({ wiki, target, langs: ["zh"], embed })).updated).toBe(1);
    const ftsRowid = () => (db.prepare(`SELECT rowid FROM pages_fts`).all() as Array<{ rowid: number }>).map((r) => r.rowid);
    const before = ftsRowid();

    rev = 2; // e.g. a template edit that does not change the rendered page
    const same = await ingestWiki({ wiki, target, langs: ["zh"], embed });
    expect(same).toMatchObject({ updated: 0, skipped: 1 });
    expect(parses).toBe(2);
    expect(embedded).toHaveLength(1);
    expect(ftsRowid()).toEqual(before);
    expect((db.prepare(`SELECT rev_id FROM pages`).get() as { rev_id: number }).rev_id).toBe(2);

    rev = 3;
    text = "<p>防风草是春季作物，售价35金。</p>";
    const changed = await ingestWiki({ wiki, target, langs: ["zh"], embed });
    expect(changed).toMatchObject({ updated: 1, skipped: 0 });
    expect(embedded).toHaveLength(2);
    expect((await new WikiIndex(sql).search("售价35金", "zh")).results[0]?.title).toBe("防风草");

    const unchanged = await ingestWiki({ wiki, target, langs: ["zh"], embed });
    expect(unchanged).toMatchObject({ updated: 0, skipped: 1 });
    expect(parses).toBe(3);
  });
});
