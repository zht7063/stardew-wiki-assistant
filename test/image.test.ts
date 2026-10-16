import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createWikiTools } from "../src/agent/tools";
import { citationFromUnknown, dedupeCitations } from "../src/shared/citations";
import { wikiImageUrl } from "../src/shared/images";
import { backfillStoredImages, mediawikiFileUrl } from "../src/ingest/backfill-images";
import { sqliteExecutor } from "../src/ingest/local-db";
import { applySchema } from "../src/ingest/pipeline";
import { proxyWikiImage } from "../src/worker/image-proxy";
import {
  extractImageFromStored,
  extractInfoboxImage,
  imageFromApiPage,
  pickMainFile,
} from "../src/wiki/image";
import { upsertStoredPage, WikiIndex } from "../src/wiki/index-store";
import { toStoredPage } from "../src/wiki/record";

const portrait = `
<table id="infoboxtable">
<tr><td colspan="2" id="infoboxheader">阿比盖尔</td></tr>
<tr><td colspan="2"><img alt="Abigail.png" src="/mediawiki/images/8/88/Abigail.png" width="128" height="192" /></td></tr>
<tr><td id="infoboxsection">生日</td><td id="infoboxdetail"><img alt="Fall.png" src="/mediawiki/images/f/f1/Fall.png" width="24" /> 秋季</td></tr>
<tr><td id="infoboxsection">最爱的礼物</td><td id="infoboxdetail"><img alt="Amethyst.png" src="/mediawiki/images/a/a1/Amethyst.png" width="24" /></td></tr>
</table>`;

describe("image extraction", () => {
  it("keeps the infobox portrait and skips icons", () => {
    expect(extractInfoboxImage(portrait, "https://zh.stardewvalleywiki.com")).toBe(
      "https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png",
    );
    expect(extractInfoboxImage("<p><img src='/mediawiki/images/8/88/Abigail.png'></p>", "https://zh.stardewvalleywiki.com")).toBeNull();
    expect(wikiImageUrl("https://evil.example/mediawiki/images/8/88/Abigail.png")).toBeNull();
    expect(wikiImageUrl("https://zh.stardewvalleywiki.com/阿比盖尔")).toBeNull();
    expect(imageFromApiPage({ pageimage: "Fall.png", thumbnail: { source: "https://zh.stardewvalleywiki.com/mediawiki/images/f/f1/Fall.png" } })).toBeNull();
    expect(
      imageFromApiPage({
        pageimage: "Abigail.png",
        thumbnail: { source: "https://zh.stardewvalleywiki.com/mediawiki/images/thumb/8/88/Abigail.png/320px-Abigail.png" },
      }),
    ).toBe("https://zh.stardewvalleywiki.com/mediawiki/images/thumb/8/88/Abigail.png/320px-Abigail.png");
  });

  it("reads an image already stored as html, a file url, or wikitext", () => {
    expect(extractImageFromStored({ body: "阿比盖尔住在鹈鹕镇。" }, "zh")).toEqual({});
    expect(extractImageFromStored({ html: portrait }, "zh").url).toBe(
      "https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png",
    );
    expect(
      extractImageFromStored(
        { body: "见图 https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png。" },
        "zh",
      ).url,
    ).toContain("/Abigail.png");
    expect(extractImageFromStored({ wikitext: "[[File:Abigail.png|128px]]\n[[File:Fall.png]]" }, "zh")).toEqual({
      file: "Abigail.png",
    });
    expect(mediawikiFileUrl("zh", "Abigail.png")).toBe("https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png");
    expect(mediawikiFileUrl("en", "File:Abigail.png")).toBe("https://stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png");
    expect(pickMainFile(["File:Spring.png", "File:Amethyst.png", "File:Abigail.png"], ["Abigail"])).toBe("Abigail.png");
    expect(pickMainFile(["File:Amethyst.png", "File:Pumpkin.png"], ["阿比盖尔"])).toBeNull();
  });

  it("backfills image urls from stored wikitext and leaves clean rows alone", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    await upsertStoredPage(
      sql,
      toStoredPage({
        lang: "zh",
        title: "阿比盖尔",
        url: "https://zh.stardewvalleywiki.com/阿比盖尔",
        revId: 1,
        html: "<p>没有图片的正文，后面补了维基语法。</p>",
      }),
    );
    await sql.run(`UPDATE pages SET body = ? WHERE title = ?`, ["[[File:Abigail.png|128px]]", "阿比盖尔"]);
    await upsertStoredPage(
      sql,
      toStoredPage({
        lang: "zh",
        title: "说明",
        url: "https://zh.stardewvalleywiki.com/说明",
        revId: 1,
        html: "<p>这一页的正文里没有图片。</p>",
      }),
    );
    const stats = await backfillStoredImages(sql);
    expect(stats.fromStored).toBe(1);
    expect(stats.stillMissing).toBe(1);
    const portraitPage = await new WikiIndex(sql).getPage("阿比盖尔", "zh");
    expect(portraitPage.image).toBe("https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png");
    const plain = await new WikiIndex(sql).getPage("说明", "zh");
    expect(plain.image).toBeUndefined();
    const again = await backfillStoredImages(sql);
    expect(again.fromStored).toBe(0);
  });

  it("puts the portrait on the citation and ignores other hosts", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    await upsertStoredPage(
      sql,
      toStoredPage({
        lang: "zh",
        title: "阿比盖尔",
        url: "https://zh.stardewvalleywiki.com/阿比盖尔",
        revId: 1,
        html: portrait,
      }),
    );
    const index = new WikiIndex(sql);
    const page = await index.getPage("阿比盖尔", "zh");
    expect(page.image).toBe("https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png");
    const tool = createWikiTools(index).find((entry) => entry.name === "get_page");
    const result = await tool?.execute("call", { title: "阿比盖尔", lang: "zh" });
    const pages = result && typeof result === "object" && "details" in result ? result.details.pages : [];
    expect(pages).toEqual([
      {
        title: "阿比盖尔",
        lang: "zh",
        url: "https://zh.stardewvalleywiki.com/阿比盖尔",
        image: "https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png",
      },
    ]);
    expect(citationFromUnknown({ title: "阿比盖尔", url: "https://zh.stardewvalleywiki.com/阿比盖尔", lang: "zh", image: "https://evil.example/a.png" })?.image).toBeUndefined();
    expect(
      dedupeCitations([
        { title: "阿比盖尔", url: "https://zh.stardewvalleywiki.com/阿比盖尔", lang: "zh" },
        {
          title: "阿比盖尔",
          url: "https://zh.stardewvalleywiki.com/阿比盖尔",
          lang: "zh",
          image: "https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png",
        },
      ])[0]?.image,
    ).toContain("Abigail.png");
  });
});

describe("image proxy", () => {
  const portraitUrl = "https://zh.stardewvalleywiki.com/mediawiki/images/8/88/Abigail.png";

  function cache() {
    const stored = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
    return {
      stored,
      binding: {
        async getWithMetadata<T>(key: string): Promise<{ value: ArrayBuffer | null; metadata: T | null }> {
          const hit = stored.get(key);
          if (!hit) return { value: null, metadata: null };
          return { value: hit.bytes, metadata: { contentType: hit.contentType } as T };
        },
        async put(key: string, value: ArrayBuffer | Uint8Array, options?: { metadata?: { contentType: string } }) {
          const view = value instanceof Uint8Array ? value : new Uint8Array(value);
          const bytes = new ArrayBuffer(view.byteLength);
          new Uint8Array(bytes).set(view);
          stored.set(key, { bytes, contentType: options?.metadata?.contentType ?? "" });
        },
      },
    };
  }

  it("refuses anything that is not a wiki image", async () => {
    let fetched = false;
    const { binding } = cache();
    const response = await proxyWikiImage(
      new Request(`https://stardewiki.example/api/img?u=${encodeURIComponent("https://evil.example/secret.png")}`),
      { WIKI_CACHE: binding },
      { waitUntil() {} },
      async () => {
        fetched = true;
        return new Response("no");
      },
    );
    expect(response.status).toBe(400);
    expect(fetched).toBe(false);
  });

  it("fetches once and serves the next request from KV", async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
    let fetches = 0;
    const { binding, stored } = cache();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil(promise: Promise<unknown>) { waits.push(promise); } };
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };
    const first = await proxyWikiImage(
      new Request(`https://stardewiki.example/api/img?u=${encodeURIComponent(portraitUrl)}`),
      { WIKI_CACHE: binding },
      ctx,
      fetchImpl,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(png);
    await Promise.all(waits);
    expect(stored.size).toBe(1);

    const second = await proxyWikiImage(
      new Request(`https://stardewiki.example/api/img?u=${encodeURIComponent(portraitUrl)}`),
      { WIKI_CACHE: binding },
      { waitUntil() {} },
      async () => {
        fetches += 1;
        return new Response("should not run", { status: 500 });
      },
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("image/png");
    expect(fetches).toBe(1);
  });
});
