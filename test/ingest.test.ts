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
    expect(page.imageUrl).toBe("https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png");
  });

  it("reads Workers AI embedding payloads", () => {
    expect(readEmbeddingMatrix({ data: [[0.1, 0.2]] })).toEqual([[0.1, 0.2]]);
    expect(readEmbeddingMatrix({ result: { data: [[1, 2, 3]] } })).toEqual([[1, 2, 3]]);
  });
});

describe("ingest pipeline", () => {
  it("preserves special characters in continuation tokens using form POST", async () => {
    let calls = 0;
    const wiki = new MediaWiki(async (input, init) => {
      expect(new URL(input).search).toBe("");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
      const params = new URLSearchParams(init?.body);
      calls += 1;
      if (calls === 1) return Response.json({ query: { allpages: [{ title: "Slime" }] }, continue: { apcontinue: "Special_Items_&_Powers" } });
      expect(params.get("apcontinue")).toBe("Special_Items_&_Powers");
      return Response.json({ query: { allpages: [{ title: "Special Items & Powers" }] } });
    }, 0);
    expect(await wiki.listTitles("en")).toEqual(["Slime", "Special Items & Powers"]);
    expect(calls).toBe(2);
  });

  it("loads a mocked wiki into sqlite and skips unchanged revisions", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      url.search = String(init?.body ?? "");
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
    expect(first).toEqual({ seen: 1, updated: 1, skipped: 0, failed: 0, images: 0 });
    const index = new WikiIndex(sql);
    const found = await index.search("阿比盖尔喜欢什么礼物？", "zh");
    expect(found.results[0]?.title).toBe("阿比盖尔");
    const page = await index.getPage("阿比盖尔", "zh", "日程表");
    expect(page.markdown).toContain("09:00");
    expect(page.markdown).not.toContain("她最喜欢紫水晶");
    expect(page.counterpart?.title).toBe("Abigail");
    expect(page.url).toContain("zh.stardewvalleywiki.com");
    expect(page.image).toBe("https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png");

    const second = await ingestWiki({ wiki, target: targetFromSql(sql), langs: ["zh"] });
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.images).toBe(0);
    expect(calls.filter((call) => call === "parse")).toHaveLength(1);
  });

  it("fills a missing portrait from pageimages without parsing the page again", async () => {
    let pass = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      url.search = String(init?.body ?? "");
      if (url.searchParams.get("list") === "allpages") {
        return Response.json({ query: { allpages: [{ title: "草莓" }] } });
      }
      if (url.searchParams.get("prop")?.includes("langlinks")) {
        pass += 1;
        const thumbnail =
          pass === 1
            ? undefined
            : { source: "https://zh.stardewvalleywiki.com/mediawiki/images/thumb/a/ab/Strawberry.png/320px-Strawberry.png" };
        return Response.json({
          query: { pages: [{ title: "草莓", lastrevid: 7, thumbnail, langlinks: [] }] },
        });
      }
      return Response.json({
        parse: {
          title: "草莓",
          text: "<table id='infoboxtable'><tr><td id='infoboxsection'>生长季节</td><td id='infoboxdetail'>春季</td></tr></table><p>草莓。</p>",
        },
      });
    };
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    const wiki = new MediaWiki(fetchImpl, 0);
    const first = await ingestWiki({ wiki, target: targetFromSql(sql), langs: ["zh"] });
    expect(first.updated).toBe(1);
    expect(first.images).toBe(0);
    const bare = await new WikiIndex(sql).getPage("草莓", "zh");
    expect(bare.image).toBeUndefined();
    const second = await ingestWiki({ wiki, target: targetFromSql(sql), langs: ["zh"] });
    expect(second.skipped).toBe(1);
    expect(second.updated).toBe(0);
    expect(second.images).toBe(1);
    const filled = await new WikiIndex(sql).getPage("草莓", "zh");
    expect(filled.image).toBe("https://zh.stardewvalleywiki.com/mediawiki/images/thumb/a/ab/Strawberry.png/320px-Strawberry.png");
  });

  it("retries describe without pageimages when that module is missing", async () => {
    const props: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      url.search = String(init?.body ?? "");
      const prop = url.searchParams.get("prop") ?? "";
      if (prop) props.push(prop);
      if (url.searchParams.get("list") === "allpages") {
        return Response.json({ query: { allpages: [{ title: "草莓" }] } });
      }
      if (prop.includes("pageimages")) return Response.json({ error: { code: "badvalue", info: "pageimages" } });
      if (prop.includes("langlinks")) {
        return Response.json({ query: { pages: [{ title: "草莓", lastrevid: 3 }] } });
      }
      return Response.json({ parse: { title: "草莓", text: "<p>草莓是春季作物，正文够长。</p>" } });
    };
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    const stats = await ingestWiki({ wiki: new MediaWiki(fetchImpl, 0), target: targetFromSql(sql), langs: ["zh"] });
    expect(stats.updated).toBe(1);
    expect(props.some((prop) => prop.includes("pageimages"))).toBe(true);
    expect(props.some((prop) => prop.includes("langlinks") && !prop.includes("pageimages"))).toBe(true);
  });

  it("retries a dropped fetch and keeps going when one page still fails", async () => {
    let drops = 1;
    let brokenAttempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      url.search = String(init?.body ?? "");
      if (drops > 0) {
        drops -= 1;
        throw new Error("fetch failed");
      }
      if (url.searchParams.get("list") === "allpages") {
        return Response.json({ query: { allpages: [{ title: "甲" }, { title: "乙" }] } });
      }
      if (url.searchParams.get("prop")?.includes("langlinks")) {
        return Response.json({
          query: {
            pages: [
              { title: "甲", lastrevid: 1 },
              { title: "乙", lastrevid: 2 },
            ],
          },
        });
      }
      if (url.searchParams.get("page") === "乙") {
        brokenAttempts += 1;
        throw new Error("fetch failed");
      }
      return Response.json({ parse: { title: "甲", text: "<p>甲的正文够长，能留下来。</p>" } });
    };
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    const wiki = new MediaWiki(fetchImpl, 0, { retryBaseMs: 0, concurrency: 2 });
    const stats = await ingestWiki({ wiki, target: targetFromSql(sql), langs: ["zh"], concurrency: 2 });
    expect(stats.updated).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.seen).toBe(2);
    expect(brokenAttempts).toBe(5);
    const index = new WikiIndex(sql);
    const found = await index.search("甲", "zh");
    expect(found.results[0]?.title).toBe("甲");
  });
});
