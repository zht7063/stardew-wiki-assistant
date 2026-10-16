import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteExecutor } from "../src/ingest/local-db";
import { MediaWiki } from "../src/ingest/mediawiki";
import { applySchema, ingestWiki, targetFromSql } from "../src/ingest/pipeline";
import { WikiIndex } from "../src/wiki/index-store";
import { toStoredPage } from "../src/wiki/record";
import { SCHEMA_SQL } from "../src/wiki/schema";
import { readEmbeddingMatrix } from "../src/wiki/embeddings";

const abigailHtml = readFileSync(new URL("./fixtures/abigail.html", import.meta.url), "utf8");

function norm(sql: string): string {
  return sql.replace(/;/g, "").replace(/\s+/g, " ").trim();
}

describe("ingest parser", () => {
  it("keeps schema.sql aligned with the statements the script applies", () => {
    const file = readFileSync(new URL("../schema/wiki.sql", import.meta.url), "utf8");
    expect(norm(file)).toBe(norm(SCHEMA_SQL));
  });

  it("turns rendered wiki HTML into infobox fields, markdown, and a search blob", () => {
    const page = toStoredPage({
      lang: "zh",
      title: "阿比盖尔",
      url: "https://zh.stardewvalleywiki.com/阿比盖尔",
      revId: 10,
      html: abigailHtml,
      counterpart: { lang: "en", title: "Abigail", url: "https://stardewvalleywiki.com/Abigail" },
    });
    expect(page.infobox.find((field) => field.label === "最爱的礼物")?.value).toBe("紫水晶、香蕉布丁、南瓜");
    expect(page.body).toContain("09:00");
    expect(page.body).not.toContain("导航不该出现");
    expect(page.sections).toContain("日程表");
    expect(page.searchText).toContain("Abigail");
    expect(page.searchText).toContain("紫水晶");
  });

  it("reads Workers AI embedding payloads", () => {
    expect(readEmbeddingMatrix({ data: [[0.1, 0.2]] })).toEqual([[0.1, 0.2]]);
    expect(readEmbeddingMatrix({ result: { data: [[1, 2, 3]] } })).toEqual([[1, 2, 3]]);
  });
});

describe("ingest pipeline", () => {
  it("loads a mocked wiki into sqlite and skips unchanged revisions", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.get("action") === "parse" ? "parse" : url.searchParams.get("list") || url.searchParams.get("prop") || "");
      if (url.searchParams.get("list") === "allpages") {
        return Response.json({ query: { allpages: [{ title: "阿比盖尔" }] } });
      }
      if (url.searchParams.get("prop")?.includes("langlinks")) {
        return Response.json({
          query: {
            pages: [{ title: "阿比盖尔", lastrevid: 42, langlinks: [{ lang: "en", title: "Abigail" }] }],
          },
        });
      }
      return Response.json({ parse: { title: "阿比盖尔", text: abigailHtml } });
    };
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    const wiki = new MediaWiki(fetchImpl, 0);
    const first = await ingestWiki({ wiki, target: targetFromSql(sql), langs: ["zh"] });
    expect(first).toEqual({ seen: 1, updated: 1, skipped: 0 });
    const index = new WikiIndex(sql);
    const found = await index.search("阿比盖尔喜欢什么礼物？", "zh");
    expect(found.results[0]?.title).toBe("阿比盖尔");
    const page = await index.getPage("阿比盖尔", "zh", "日程表");
    expect(page.markdown).toContain("09:00");
    expect(page.markdown).not.toContain("她最喜欢紫水晶");
    expect(page.counterpart?.title).toBe("Abigail");
    expect(page.url).toContain("zh.stardewvalleywiki.com");

    const second = await ingestWiki({ wiki, target: targetFromSql(sql), langs: ["zh"] });
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(calls.filter((call) => call === "parse")).toHaveLength(1);
  });
});
