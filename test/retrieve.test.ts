import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteExecutor } from "../src/ingest/local-db";
import { applySchema } from "../src/ingest/pipeline";
import { upsertStoredPage, WikiIndex, type VectorHit } from "../src/wiki/index-store";
import { toStoredPage } from "../src/wiki/record";
import { hitsFromMatches } from "../src/wiki/vectors";

function memoryIndex(vectors?: (query: string) => Promise<VectorHit[]>) {
  const db = new DatabaseSync(":memory:");
  const sql = sqliteExecutor(db);
  return { sql, index: new WikiIndex(sql, vectors), ready: applySchema(sql) };
}

describe("retrieval", () => {
  it("falls back to the English page when only that side has the title", async () => {
    const { sql, index, ready } = memoryIndex();
    await ready;
    await upsertStoredPage(
      sql,
      toStoredPage({
        lang: "en",
        title: "Ancient Seed",
        url: "https://stardewvalleywiki.com/Ancient_Seed",
        revId: 3,
        html: "<p>An Ancient Seed can be planted.</p><table class='wikitable'><tr><th>Season</th><td>Spring</td></tr></table>",
        counterpart: { lang: "zh", title: "古代种子", url: "https://zh.stardewvalleywiki.com/古代种子" },
      }),
    );
    const search = await index.search("古代种子怎么种？", "zh");
    expect(search.results.some((hit) => hit.title === "Ancient Seed" && hit.lang === "en")).toBe(true);
    expect(search.note).toContain("英文");
    const page = await index.getPage("古代种子", "zh");
    expect(page.missing).toBeFalsy();
    expect(page.lang).toBe("en");
    expect(page.markdown.toLowerCase()).toContain("ancient seed");
    expect(page.note).toContain("英文");
    const mapped = await index.mapTitle("古代种子", "zh");
    expect(mapped.to?.title).toBe("Ancient Seed");
  });

  it("finds a two-character Chinese name in the infobox", async () => {
    const { sql, index, ready } = memoryIndex();
    await ready;
    await upsertStoredPage(
      sql,
      toStoredPage({
        lang: "zh",
        title: "草莓",
        url: "https://zh.stardewvalleywiki.com/草莓",
        revId: 1,
        html: "<table id='infoboxtable'><tr><td id='infoboxsection'>生长季节</td><td id='infoboxdetail'>春季</td></tr></table><p>草莓是一种水果。</p>",
      }),
    );
    const search = await index.search("草莓", "zh");
    expect(search.results[0]?.title).toBe("草莓");
    expect(search.results[0]?.url).toBe("https://zh.stardewvalleywiki.com/草莓");
  });

  it("merges a vector hit that keyword search missed", async () => {
    const { sql, index, ready } = memoryIndex(async () => [{ lang: "zh", title: "南瓜", score: 0.91 }]);
    await ready;
    await upsertStoredPage(
      sql,
      toStoredPage({
        lang: "zh",
        title: "南瓜",
        url: "https://zh.stardewvalleywiki.com/南瓜",
        revId: 1,
        html: "<p>南瓜在秋季生长。</p>",
      }),
    );
    const search = await index.search("哪种橙色的秋季作物能做汤？", "zh");
    expect(search.results.some((hit) => hit.title === "南瓜")).toBe(true);
  });

  it("reads vector metadata into hits", () => {
    expect(hitsFromMatches([{ score: 0.4, metadata: { lang: "zh", title: "南瓜" } }, { score: 0.1, metadata: { lang: "fr", title: "x" } }])).toEqual([
      { lang: "zh", title: "南瓜", score: 0.4 },
    ]);
  });
});
