import type { Citation, WikiLang } from "../shared/types";
import { pageUrl, type MapPayload, type PagePayload, type SearchHit, type SearchPayload } from "./client";
import { queryCandidates } from "./parse";
import { capForTool, sliceMarkdownSection, type StoredPage } from "./record";
import type { WikiSource } from "./source";

export type SqlParam = string | number | null;

export interface SqlExecutor {
  all<T>(sql: string, params: SqlParam[]): Promise<T[]>;
  run(sql: string, params: SqlParam[]): Promise<void>;
}

export interface VectorHit {
  lang: WikiLang;
  title: string;
  score: number;
}

interface PageRow {
  lang: string;
  title: string;
  url: string;
  rev_id: number;
  counterpart_lang: string | null;
  counterpart_title: string | null;
  counterpart_url: string | null;
  infobox_json: string;
  sections_json: string;
  search_text: string;
  body: string;
  updated_at: number;
}

const UPSERT_PAGE = `INSERT INTO pages (
  lang, title, url, rev_id, counterpart_lang, counterpart_title, counterpart_url,
  infobox_json, sections_json, search_text, body, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(lang, title) DO UPDATE SET
  url = excluded.url,
  rev_id = excluded.rev_id,
  counterpart_lang = excluded.counterpart_lang,
  counterpart_title = excluded.counterpart_title,
  counterpart_url = excluded.counterpart_url,
  infobox_json = excluded.infobox_json,
  sections_json = excluded.sections_json,
  search_text = excluded.search_text,
  body = excluded.body,
  updated_at = excluded.updated_at`;

const SELECT_PAGE = `SELECT lang, title, url, rev_id, counterpart_lang, counterpart_title, counterpart_url,
  infobox_json, sections_json, search_text, body, updated_at
  FROM pages WHERE lang = ? AND title = ?`;

export async function upsertStoredPage(sql: SqlExecutor, page: StoredPage): Promise<void> {
  await sql.run(UPSERT_PAGE, [
    page.lang,
    page.title,
    page.url,
    page.revId,
    page.counterpart?.lang ?? null,
    page.counterpart?.title ?? null,
    page.counterpart?.url ?? null,
    JSON.stringify(page.infobox),
    JSON.stringify(page.sections),
    page.searchText,
    page.body,
    Date.now(),
  ]);
  await sql.run(`DELETE FROM pages_fts WHERE title = ? AND lang = ?`, [page.title, page.lang]);
  await sql.run(`INSERT INTO pages_fts (title, search_text, lang) VALUES (?, ?, ?)`, [
    page.title,
    page.searchText,
    page.lang,
  ]);
}

export function matchQuery(needle: string): string | null {
  const cleaned = needle.replace(/["*^:()\\]/g, "").trim();
  if ([...cleaned].length < 3) return null;
  return `"${cleaned}"`;
}

function otherLang(lang: WikiLang): WikiLang {
  return lang === "zh" ? "en" : "zh";
}

function asLang(value: string | null): WikiLang | null {
  if (value === "zh" || value === "en") return value;
  return null;
}

function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = needle ? flat.indexOf(needle) : -1;
  const start = at >= 0 ? Math.max(0, at - 16) : 0;
  const slice = flat.slice(start, start + 90);
  return at > 16 ? `…${slice}` : slice;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function counterpartOf(row: PageRow): Citation | undefined {
  const lang = asLang(row.counterpart_lang);
  if (!lang || !row.counterpart_title) return undefined;
  return {
    lang,
    title: row.counterpart_title,
    url: row.counterpart_url || pageUrl(lang, row.counterpart_title),
  };
}

function rowToPage(row: PageRow, section?: string, note?: string): PagePayload {
  const infobox = parseJson<PagePayload["infobox"]>(row.infobox_json, []);
  const sections = parseJson<string[]>(row.sections_json, []);
  let markdown = row.body;
  if (section) {
    const sliced = sliceMarkdownSection(markdown, section);
    markdown = sliced.found
      ? sliced.markdown
      : `没有名为「${section}」的章节。可试：${sections.slice(0, 20).join("、") || "（这一页没有章节）"}`;
  }
  const capped = capForTool(markdown);
  const lang = asLang(row.lang) ?? "zh";
  return {
    title: row.title,
    lang,
    url: row.url,
    infobox,
    markdown: capped.markdown,
    sections,
    truncated: capped.truncated,
    counterpart: counterpartOf(row),
    note,
    missing: false,
  };
}

function missingPage(title: string, lang: WikiLang): PagePayload {
  return {
    title,
    lang,
    url: pageUrl(lang, title),
    infobox: [],
    markdown: "没有找到这一页。",
    sections: [],
    truncated: false,
    missing: true,
    note: "索引里没有这一页。",
  };
}

interface ScoredHit extends SearchHit {
  score: number;
}

/**
 * Keyword search over D1/SQLite, with an optional vector list merged in.
 * Chinese queries use FTS5 trigrams (3+ characters) and a short-string fallback.
 */
export class WikiIndex implements WikiSource {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly vectors?: (query: string) => Promise<VectorHit[]>,
  ) {}

  async search(query: string, lang: WikiLang): Promise<SearchPayload> {
    const needle = pickNeedle(query);
    try {
      const countRow = await this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM pages`, []);
      const total = Number(countRow[0]?.n ?? 0);
      if (total === 0) {
        return {
          query,
          lang,
          results: [],
          note: "索引还是空的。在自己的电脑上跑一次 npm run ingest，答案才会有内容。",
        };
      }
      const lexical = await this.lexical(lang, needle);
      const vectorHits = this.vectors ? await this.vectors(query).catch(() => []) : [];
      let note: string | undefined;
      let extra: PageRow[] = [];
      const preferredVectors = vectorHits.filter((hit) => hit.lang === lang);
      if (lexical.length + preferredVectors.length < 2) {
        extra = await this.lexical(otherLang(lang), needle);
        if (extra.length > 0 || vectorHits.some((hit) => hit.lang !== lang)) {
          note = lang === "zh" ? "中文索引里很少，下面也用了英文页。" : "英文索引里很少，下面也用了中文页。";
        }
      }
      const hits = await this.merge(lang, needle, [...lexical, ...extra], vectorHits);
      return { query, lang, results: hits.slice(0, 8), note };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("no such table")) {
        return {
          query,
          lang,
          results: [],
          note: "索引表还没建。先执行 schema/wiki.sql，再跑 npm run ingest。",
        };
      }
      throw error;
    }
  }

  async getPage(title: string, lang: WikiLang, section?: string): Promise<PagePayload> {
    const normalized = normalizeTitle(title);
    const direct = await this.one(SELECT_PAGE, [lang, normalized]);
    if (direct) return rowToPage(direct, section);
    const linked = await this.one(
      `SELECT lang, title, url, rev_id, counterpart_lang, counterpart_title, counterpart_url,
        infobox_json, sections_json, search_text, body, updated_at
       FROM pages WHERE counterpart_lang = ? AND counterpart_title = ? LIMIT 1`,
      [lang, normalized],
    );
    if (linked) {
      const note = linked.lang === "en" ? "中文 wiki 没有这个标题，下面用英文 wiki 补上。" : "英文 wiki 没有这个标题，下面用中文 wiki。";
      return rowToPage(linked, section, note);
    }
    const sameTitle = await this.one(
      `SELECT lang, title, url, rev_id, counterpart_lang, counterpart_title, counterpart_url,
        infobox_json, sections_json, search_text, body, updated_at
       FROM pages WHERE lang = ? AND title = ? LIMIT 1`,
      [otherLang(lang), normalized],
    );
    if (sameTitle) {
      const note = sameTitle.lang === "en" ? "中文 wiki 没有这个标题，下面用英文 wiki 补上。" : "英文 wiki 没有这个标题，下面用中文 wiki。";
      return rowToPage(sameTitle, section, note);
    }
    return missingPage(normalized, lang);
  }

  async mapTitle(title: string, from: WikiLang): Promise<MapPayload> {
    const normalized = normalizeTitle(title);
    const source: Citation = { title: normalized, lang: from, url: pageUrl(from, normalized) };
    const direct = await this.one(SELECT_PAGE, [from, normalized]);
    if (direct) {
      const to = counterpartOf(direct);
      return to ? { from: { title: direct.title, lang: from, url: direct.url }, to } : { from: source, note: "这页没有对应的另一种语言链接。" };
    }
    const inverse = await this.one(
      `SELECT lang, title, url, rev_id, counterpart_lang, counterpart_title, counterpart_url,
        infobox_json, sections_json, search_text, body, updated_at
       FROM pages WHERE counterpart_lang = ? AND counterpart_title = ? LIMIT 1`,
      [from, normalized],
    );
    if (inverse && asLang(inverse.lang)) {
      return {
        from: source,
        to: { title: inverse.title, lang: asLang(inverse.lang) as WikiLang, url: inverse.url },
      };
    }
    return { from: source, note: "索引里没有这页的语言链接。" };
  }

  private async lexical(lang: WikiLang, needle: string): Promise<PageRow[]> {
    const exact = needle
      ? await this.sql.all<PageRow>(SELECT_PAGE, [lang, needle])
      : [];
    const match = matchQuery(needle);
    let fts: PageRow[] = [];
    if (match) {
      try {
        fts = await this.sql.all<PageRow>(
          `SELECT p.lang, p.title, p.url, p.rev_id, p.counterpart_lang, p.counterpart_title, p.counterpart_url,
             p.infobox_json, p.sections_json, p.search_text, p.body, p.updated_at
           FROM pages_fts
           JOIN pages p ON p.title = pages_fts.title AND p.lang = pages_fts.lang
           WHERE pages_fts MATCH ? AND p.lang = ?
           ORDER BY bm25(pages_fts)
           LIMIT 8`,
          [match, lang],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("no such table")) throw error;
        fts = [];
      }
    }
    let short: PageRow[] = [];
    if (needle && [...needle].length < 3) {
      short = await this.sql.all<PageRow>(
        `SELECT lang, title, url, rev_id, counterpart_lang, counterpart_title, counterpart_url,
           infobox_json, sections_json, search_text, body, updated_at
         FROM pages
         WHERE lang = ? AND (title = ? OR instr(title, ?) > 0 OR instr(infobox_json, ?) > 0)
         LIMIT 8`,
        [lang, needle, needle, needle],
      );
    }
    const seen = new Set<string>();
    const rows: PageRow[] = [];
    for (const row of [...exact, ...fts, ...short]) {
      const key = `${row.lang}\0${row.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    return rows;
  }

  private async merge(preferred: WikiLang, needle: string, rows: PageRow[], vectors: VectorHit[]): Promise<SearchHit[]> {
    const byKey = new Map<string, { row?: PageRow; vector?: number; lexicalRank: number }>();
    rows.forEach((row, index) => {
      byKey.set(`${row.lang}\0${row.title}`, { row, lexicalRank: index });
    });
    const missing: VectorHit[] = [];
    for (const hit of vectors) {
      const key = `${hit.lang}\0${hit.title}`;
      const existing = byKey.get(key);
      if (existing) existing.vector = hit.score;
      else missing.push(hit);
    }
    for (const hit of missing) {
      const row = await this.one(SELECT_PAGE, [hit.lang, hit.title]);
      if (!row) continue;
      byKey.set(`${hit.lang}\0${hit.title}`, { row, vector: hit.score, lexicalRank: 20 });
    }
    const scored: ScoredHit[] = [];
    for (const entry of byKey.values()) {
      if (!entry.row) continue;
      const lang = asLang(entry.row.lang);
      if (!lang) continue;
      let score = 1 / (1 + entry.lexicalRank);
      if (typeof entry.vector === "number") score += entry.vector;
      if (entry.row.title === needle) score += 2;
      if (lang === preferred) score += 0.15;
      scored.push({
        title: entry.row.title,
        url: entry.row.url,
        lang,
        snippet: snippet(entry.row.search_text, needle),
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ score: _score, ...hit }) => hit);
  }

  private async one(sql: string, params: SqlParam[]): Promise<PageRow | null> {
    const rows = await this.sql.all<PageRow>(sql, params);
    return rows[0] ?? null;
  }
}

export function pickNeedle(query: string): string {
  const candidates = queryCandidates(query);
  return candidates[candidates.length - 1] || query.trim();
}

export function normalizeTitle(title: string): string {
  return title.trim().replace(/_/g, " ");
}
