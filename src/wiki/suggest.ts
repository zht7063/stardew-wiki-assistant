import { wikiImageUrl } from "../shared/images";
import type { WikiLang } from "../shared/types";
import type { SqlExecutor } from "./index-store";
import type { InfoboxField } from "./parse";

export interface Suggestion {
  title: string;
  question: string;
  lang: WikiLang;
  url: string;
  image?: string;
}

const META_TITLES = new Set(
  [
    "首页",
    "星露谷物语",
    "星露谷物语wiki",
    "星露谷维基",
    "stardew valley wiki",
    "stardew valley",
    "帮助",
    "版权",
    "关于",
    "沙盒",
    "编辑指南",
    "模组",
    "modding",
    "版本历史",
    "更新历史",
    "更新",
    "版本",
  ].map((title) => title.toLowerCase()),
);

export type PageKind = "villager" | "crop" | "fish" | "item";

const QUESTIONS: Record<PageKind, string[]> = {
  villager: ["{name}喜欢什么礼物？", "{name}的生日是哪一天？", "{name}住在哪里？", "怎么和{name}变成朋友？"],
  crop: ["{name}在什么季节种植？", "{name}要多久才能成熟？", "{name}的种子在哪买？", "种{name}划算吗？"],
  fish: ["{name}在哪里可以钓到？", "{name}什么季节会出现？", "{name}要在什么天气钓？", "钓{name}难不难？"],
  item: ["{name}要怎么获得？", "{name}有什么用？", "{name}能卖多少钱？", "{name}是怎么做出来的？"],
};

export function parseCount(value: string | null): number {
  if (value === null || value.trim() === "") return 4;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(8, Math.max(1, Math.floor(parsed)));
}

export function classifyPage(fields: InfoboxField[]): PageKind {
  const labels = fields.map((field) => field.label).join(" ");
  if (/生日|居住于|可结婚|婚姻/.test(labels)) return "villager";
  if (/生长季节|生长时间|种子价格|成熟时间|收获/.test(labels)) return "crop";
  if (/鱼饵|难度/.test(labels) || (/地点/.test(labels) && /时间/.test(labels) && /季节|天气/.test(labels))) return "fish";
  return "item";
}

export function questionFor(title: string, fields: InfoboxField[], rng: () => number = Math.random): string {
  const templates = QUESTIONS[classifyPage(fields)];
  const index = Math.min(templates.length - 1, Math.max(0, Math.floor(rng() * templates.length)));
  const template = templates[index] ?? templates[0] ?? "{name}是什么？";
  return template.replaceAll("{name}", title.trim());
}

export function isSuggestablePage(input: { title: string; infoboxJson: string; body?: string }): boolean {
  const title = input.title.trim();
  if (!title) return false;
  if (/消歧义|消歧|disambiguation/i.test(title)) return false;
  if (/^(?:分类|模板|文件|帮助|用户|讨论|category|template|file)[:：]/i.test(title)) return false;
  if (META_TITLES.has(title.toLowerCase())) return false;
  const body = input.body ?? "";
  if (/^\s*#(?:redirect|重定向)\b/i.test(body)) return false;
  if (/\{\{\s*(?:disambiguation|消歧义)/i.test(body)) return false;
  let fields: InfoboxField[] = [];
  try {
    const parsed = JSON.parse(input.infoboxJson) as unknown;
    if (Array.isArray(parsed)) fields = parsed.filter((field): field is InfoboxField => {
      if (!field || typeof field !== "object") return false;
      const row = field as { label?: unknown; value?: unknown };
      return typeof row.label === "string" && typeof row.value === "string";
    });
  } catch {
    return false;
  }
  if (fields.length === 0) return false;
  const labels = fields.map((field) => field.label).join(" ");
  return /生日|居住于|地址|礼物|生长|季节|种子|收获|地点|时间|天气|难度|售价|售出|来源|效果|配方|能量|恢复|制作|用途|鱼|作物|花费|材料|朋友|婚姻|可结婚|诊所|职业/.test(
    labels,
  );
}

interface SuggestionRow {
  lang: string;
  title: string;
  url: string;
  infobox_json: string;
  body: string;
  image_url?: string | null;
}

async function hasImageColumn(sql: SqlExecutor): Promise<boolean> {
  try {
    await sql.all(`SELECT image_url FROM pages LIMIT 1`, []);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such column/i.test(message)) return false;
    throw error;
  }
}

function fieldsOf(json: string): InfoboxField[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((field): field is InfoboxField => {
      if (!field || typeof field !== "object") return false;
      const row = field as { label?: unknown; value?: unknown };
      return typeof row.label === "string" && typeof row.value === "string";
    });
  } catch {
    return [];
  }
}

/** Random content pages (items, villagers, crops, fish). Redirects and meta pages stay out. */
export async function sampleSuggestions(
  sql: SqlExecutor,
  count: number,
  rng: () => number = Math.random,
): Promise<Suggestion[]> {
  const n = parseCount(String(count));
  const imageColumn = await hasImageColumn(sql);
  const imageSelect = imageColumn ? ", image_url" : "";
  const rows = await sql.all<SuggestionRow>(
    `SELECT lang, title, url, infobox_json, body${imageSelect}
     FROM pages
     WHERE lang = 'zh'
       AND infobox_json != '[]'
       AND infobox_json != ''
       AND title NOT LIKE '%消歧义%'
       AND title NOT LIKE '%消歧%'
       AND lower(title) NOT LIKE '%disambiguation%'
       AND body NOT LIKE '#REDIRECT%'
       AND body NOT LIKE '#重定向%'
     ORDER BY RANDOM()
     LIMIT ?`,
    [Math.max(n * 8, 32)],
  );
  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.lang !== "zh") continue;
    if (seen.has(row.title)) continue;
    if (!isSuggestablePage({ title: row.title, infoboxJson: row.infobox_json, body: row.body })) continue;
    seen.add(row.title);
    const fields = fieldsOf(row.infobox_json);
    const image = imageColumn ? wikiImageUrl(row.image_url) : null;
    suggestions.push({
      title: row.title,
      question: questionFor(row.title, fields, rng),
      lang: "zh",
      url: row.url,
      ...(image ? { image } : {}),
    });
    if (suggestions.length >= n) break;
  }
  return suggestions;
}

export async function randomResponse(sql: SqlExecutor, url: URL): Promise<Response> {
  try {
    const suggestions = await sampleSuggestions(sql, parseCount(url.searchParams.get("n")));
    return Response.json({ suggestions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return Response.json({ suggestions: [] });
    throw error;
  }
}
