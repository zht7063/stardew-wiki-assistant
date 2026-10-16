import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteExecutor } from "../src/ingest/local-db";
import { applySchema } from "../src/ingest/pipeline";
import { upsertStoredPage, WikiIndex } from "../src/wiki/index-store";
import { toStoredPage } from "../src/wiki/record";
import { classifyPage, isSuggestablePage, parseCount, questionFor, randomResponse, sampleSuggestions } from "../src/wiki/suggest";

function page(title: string, html: string, bodyOverride?: string) {
  const stored = toStoredPage({
    lang: "zh",
    title,
    url: `https://zh.stardewvalleywiki.com/${encodeURIComponent(title)}`,
    revId: 1,
    html,
  });
  if (bodyOverride !== undefined) stored.body = bodyOverride;
  return stored;
}

const villager = `<table id="infoboxtable"><tr><td id="infoboxsection">生日</td><td id="infoboxdetail">秋季13日</td></tr><tr><td id="infoboxsection">居住于</td><td id="infoboxdetail">鹈鹕镇</td></tr></table>`;
const crop = `<table id="infoboxtable"><tr><td id="infoboxsection">生长季节</td><td id="infoboxdetail">春季</td></tr></table>`;
const fish = `<table id="infoboxtable"><tr><td id="infoboxsection">地点</td><td id="infoboxdetail">山间湖泊</td></tr><tr><td id="infoboxsection">时间</td><td id="infoboxdetail">任何时候</td></tr><tr><td id="infoboxsection">季节</td><td id="infoboxdetail">春季</td></tr></table>`;
const item = `<table id="infoboxtable"><tr><td id="infoboxsection">来源</td><td id="infoboxdetail">采矿</td></tr><tr><td id="infoboxsection">售出价格</td><td id="infoboxdetail">100金</td></tr></table>`;

describe("/api/random", () => {
  it("turns a sampled entry into one natural Chinese question", () => {
    expect(classifyPage([{ label: "生日", value: "秋季13日" }])).toBe("villager");
    expect(classifyPage([{ label: "生长季节", value: "春季" }])).toBe("crop");
    expect(classifyPage([{ label: "地点", value: "河" }, { label: "时间", value: "早上" }, { label: "天气", value: "晴" }])).toBe("fish");
    expect(questionFor("阿比盖尔", [{ label: "生日", value: "秋" }, { label: "居住于", value: "镇" }], () => 0)).toBe("阿比盖尔喜欢什么礼物？");
    expect(questionFor("草莓", [{ label: "生长季节", value: "春季" }], () => 0)).toBe("草莓在什么季节种植？");
    expect(questionFor("鲤鱼", [{ label: "地点", value: "河" }, { label: "时间", value: "全天" }, { label: "季节", value: "春" }], () => 0)).toBe("鲤鱼在哪里可以钓到？");
    expect(questionFor("紫水晶", [{ label: "来源", value: "矿洞" }], () => 0.99)).toBe("紫水晶是怎么做出来的？");
    expect(parseCount(null)).toBe(4);
    expect(parseCount("0")).toBe(1);
    expect(parseCount("99")).toBe(8);
    expect(parseCount("nope")).toBe(4);
  });

  it("skips redirects, disambiguation, and meta pages", () => {
    expect(isSuggestablePage({ title: "阿比盖尔 (消歧义)", infoboxJson: JSON.stringify([{ label: "生日", value: "秋" }]), body: "" })).toBe(false);
    expect(isSuggestablePage({ title: "首页", infoboxJson: JSON.stringify([{ label: "来源", value: "无" }]), body: "欢迎" })).toBe(false);
    expect(isSuggestablePage({ title: "草莓", infoboxJson: "[]", body: "草莓" })).toBe(false);
    expect(isSuggestablePage({ title: "旧页", infoboxJson: JSON.stringify([{ label: "来源", value: "无" }]), body: "#REDIRECT [[草莓]]" })).toBe(false);
    expect(isSuggestablePage({ title: "宝石", infoboxJson: JSON.stringify([{ label: "来源", value: "矿" }]), body: "{{消歧义}}" })).toBe(false);
    expect(isSuggestablePage({ title: "草莓", infoboxJson: JSON.stringify([{ label: "生长季节", value: "春季" }]), body: "草莓" })).toBe(true);
  });

  it("returns real content pages from the index", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqliteExecutor(db);
    await applySchema(sql);
    const pages = [
      page("阿比盖尔", villager),
      page("草莓", crop),
      page("鲤鱼", fish),
      page("紫水晶", item),
      page("阿比盖尔 (消歧义)", villager),
      page("首页", item),
      page("旧页", item, "#REDIRECT [[草莓]]"),
      page("宝石", item, "{{消歧义}}"),
      page("说明", "<p>没有信息卡。</p>"),
    ];
    for (const stored of pages) await upsertStoredPage(sql, stored);

    const suggestions = await sampleSuggestions(sql, 4, () => 0);
    expect(suggestions).toHaveLength(4);
    const titles = suggestions.map((suggestion) => suggestion.title).sort();
    expect(titles).toEqual(["草莓", "紫水晶", "阿比盖尔", "鲤鱼"].sort());
    for (const suggestion of suggestions) {
      expect(suggestion.lang).toBe("zh");
      expect(suggestion.question.includes(suggestion.title)).toBe(true);
      expect(suggestion.question.endsWith("？")).toBe(true);
      expect(suggestion.url).toContain("zh.stardewvalleywiki.com");
    }
    expect(suggestions.find((suggestion) => suggestion.title === "阿比盖尔")?.question).toBe("阿比盖尔喜欢什么礼物？");
    expect(suggestions.find((suggestion) => suggestion.title === "草莓")?.question).toBe("草莓在什么季节种植？");

    const response = await randomResponse(sql, new URL("https://stardewiki.example/api/random?n=2"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { suggestions: Array<{ title: string; question: string }> };
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions.every((suggestion) => suggestion.question.includes(suggestion.title))).toBe(true);
  });

  it("still suggests pages when the image column has not been migrated", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE pages (
      lang TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, rev_id INTEGER NOT NULL DEFAULT 0,
      counterpart_lang TEXT, counterpart_title TEXT, counterpart_url TEXT,
      infobox_json TEXT NOT NULL DEFAULT '[]', sections_json TEXT NOT NULL DEFAULT '[]',
      search_text TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY (lang, title)
    )`);
    db.prepare(
      `INSERT INTO pages (lang, title, url, rev_id, infobox_json, sections_json, search_text, body, updated_at)
       VALUES ('zh', '草莓', 'https://zh.stardewvalleywiki.com/草莓', 1, ?, '[]', '草莓', '草莓是春季水果', 1)`,
    ).run(JSON.stringify([{ label: "生长季节", value: "春季" }]));
    const sql = sqliteExecutor(db);
    const suggestions = await sampleSuggestions(sql, 4, () => 0);
    expect(suggestions.map((suggestion) => suggestion.title)).toEqual(["草莓"]);
    expect(suggestions[0]?.image).toBeUndefined();
    expect(suggestions[0]?.question).toBe("草莓在什么季节种植？");
    const page = await new WikiIndex(sql).getPage("草莓", "zh");
    expect(page.image).toBeUndefined();
    expect(page.markdown).toContain("草莓");
  });
});
