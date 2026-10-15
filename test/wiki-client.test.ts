import { describe, expect, it } from "vitest";
import { WikiClient, USER_AGENT } from "../src/wiki/client";
import { formatPage } from "../src/wiki/format";

const abigailHtml = `<p>阿比盖尔住在鹈鹕镇。</p>`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("wiki client", () => {
  it("retries a shorter keyword and sends a descriptive user agent", async () => {
    const calls: string[] = [];
    const client = new WikiClient(async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.get("srsearch") || url.searchParams.get("search") || "");
      expect(new Headers(init?.headers).get("User-Agent")).toBe(USER_AGENT);
      const query = url.searchParams.get("srsearch");
      if (url.searchParams.get("list") === "search" && query === "阿比盖尔") {
        return jsonResponse({ query: { search: [{ title: "阿比盖尔", snippet: "<span>居民</span> 阿比盖尔" }] } });
      }
      return jsonResponse({ query: { search: [] } });
    });
    const result = await client.search("阿比盖尔喜欢什么礼物？", "zh");
    expect(result.results[0]?.title).toBe("阿比盖尔");
    expect(result.results[0]?.snippet).toBe("居民 阿比盖尔");
    expect(result.results[0]?.url).toContain("https://zh.stardewvalleywiki.com/");
    expect(result.note).toContain("阿比盖尔");
    expect(calls).toContain("阿比盖尔");
  });

  it("falls back to the English page and keeps the Chinese langlink", async () => {
    const client = new WikiClient(async (input) => {
      const url = new URL(String(input));
      const action = url.searchParams.get("action");
      const host = url.hostname;
      if (action === "parse" && host.startsWith("zh.")) {
        return jsonResponse({ error: { code: "missingtitle", info: "The page you specified doesn't exist." } });
      }
      if (action === "query" && host.startsWith("zh.")) {
        return jsonResponse({ query: { pages: [{ title: "Ancient Seed", missing: true }] } });
      }
      if (action === "parse") {
        return jsonResponse({
          parse: { title: "Ancient Seed", text: abigailHtml, sections: [{ line: "Sources" }] },
        });
      }
      return jsonResponse({
        query: { pages: [{ title: "Ancient Seed", langlinks: [{ lang: "zh", title: "古代种子" }] }] },
      });
    });
    const page = await client.getPage("Ancient Seed", "zh");
    expect(page.missing).toBe(false);
    expect(page.lang).toBe("en");
    expect(page.note).toContain("英文 wiki");
    expect(page.counterpart?.title).toBe("古代种子");
    const text = formatPage(page);
    expect(text).toContain("古代种子");
    expect(text).toContain("阿比盖尔住在鹈鹕镇");
  });
});
