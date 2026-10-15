import type { Citation, WikiLang } from "../shared/types";
import { parseWikiHtml, queryCandidates, type InfoboxField } from "./parse";

export const USER_AGENT =
  "StardewWikiAssistant/0.1 (personal reading aid for a player; MediaWiki Action API; +https://github.com/zht7063/stardew-wiki-assistant)";

const API: Record<WikiLang, string> = {
  zh: "https://zh.stardewvalleywiki.com/mediawiki/api.php",
  en: "https://stardewvalleywiki.com/mediawiki/api.php",
};

const SITE: Record<WikiLang, string> = {
  zh: "https://zh.stardewvalleywiki.com",
  en: "https://stardewvalleywiki.com",
};

export interface WikiCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface SearchHit {
  title: string;
  url: string;
  lang: WikiLang;
  snippet: string;
}

export interface SearchPayload {
  query: string;
  lang: WikiLang;
  results: SearchHit[];
  note?: string;
}

export interface PagePayload {
  title: string;
  lang: WikiLang;
  url: string;
  infobox: InfoboxField[];
  markdown: string;
  sections: string[];
  truncated: boolean;
  counterpart?: Citation;
  note?: string;
  missing?: boolean;
}

export interface MapPayload {
  from: Citation;
  to?: Citation;
  note?: string;
}

interface ApiError {
  code?: string;
  info?: string;
}

async function digestKey(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `wiki:${hex}`;
}

export function pageUrl(lang: WikiLang, title: string): string {
  const slug = encodeURIComponent(title.trim().replace(/ /g, "_"));
  return `${SITE[lang]}/${slug}`;
}

function otherLang(lang: WikiLang): WikiLang {
  return lang === "zh" ? "en" : "zh";
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "*" in value && typeof value["*"] === "string") {
    return value["*"];
  }
  return "";
}

export class WikiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cache?: WikiCache;

  constructor(fetchImpl?: typeof fetch, cache?: WikiCache) {
    // A bare `fetch(...)` inside a Worker is an illegal invocation: the
    // runtime method needs `globalThis` as `this`. Tests pass their own fetch.
    this.fetchImpl = fetchImpl
      ? (input, init) => fetchImpl(input, init)
      : (input, init) => globalThis.fetch(input, init);
    this.cache = cache;
  }

  async search(query: string, lang: WikiLang): Promise<SearchPayload> {
    const candidates = queryCandidates(query);
    for (const candidate of candidates) {
      const hits = await this.searchOnce(lang, candidate);
      if (hits.length > 0) {
        return {
          query,
          lang,
          results: hits,
          note: candidate === query.trim() ? undefined : `用更短的关键词「${candidate}」找到的`,
        };
      }
    }
    const opener = candidates[candidates.length - 1] ?? query.trim();
    const titles = await this.openSearch(lang, opener);
    if (titles.length > 0) {
      return {
        query,
        lang,
        note: "全文搜索没有命中，下面是标题接近的页面",
        results: titles.map((title) => ({ title, url: pageUrl(lang, title), lang, snippet: "" })),
      };
    }
    return {
      query,
      lang,
      results: [],
      note: "没有匹配的页面。换一个更短的标题，或改用另一种语言。",
    };
  }

  async getPage(title: string, lang: WikiLang, section?: string): Promise<PagePayload> {
    const primary = await this.loadPage(title, lang, section);
    if (!primary.missing) {
      primary.counterpart = await this.counterpartOf(primary.title, lang);
      return primary;
    }
    const mapped = await this.lookupLanglink(title, lang, otherLang(lang));
    if (mapped) {
      const preferred = await this.loadPage(mapped.title, mapped.lang, section);
      if (!preferred.missing) {
        preferred.note =
          mapped.lang === "zh"
            ? "中文页是通过语言链接找到的。"
            : "中文 wiki 没有这个标题，下面用英文 wiki 补上。";
        preferred.counterpart = await this.counterpartOf(preferred.title, preferred.lang);
        return preferred;
      }
    }
    const fallback = await this.loadPage(title, otherLang(lang), section);
    if (!fallback.missing) {
      fallback.note =
        fallback.lang === "en"
          ? "中文 wiki 没有这个标题，下面用英文 wiki 补上。"
          : "英文 wiki 没有这个标题，下面用中文 wiki。";
      fallback.counterpart = await this.counterpartOf(fallback.title, fallback.lang);
      return fallback;
    }
    return primary;
  }

  async mapTitle(title: string, from: WikiLang): Promise<MapPayload> {
    const source: Citation = { title, lang: from, url: pageUrl(from, title) };
    const to = await this.lookupLanglink(title, from, otherLang(from));
    if (!to) {
      return { from: source, note: "这页没有对应的另一种语言链接。" };
    }
    return { from: source, to };
  }

  private async searchOnce(lang: WikiLang, query: string): Promise<SearchHit[]> {
    const data = await this.api(lang, {
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: "5",
      srnamespace: "0",
    });
    const rows = data?.query?.search;
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => {
        const title = typeof row?.title === "string" ? row.title : "";
        if (!title) return null;
        const snippet = asText(row.snippet).replace(/<[^>]+>/g, "");
        return { title, url: pageUrl(lang, title), lang, snippet: snippet.replace(/\s+/g, " ").trim() };
      })
      .filter((hit): hit is SearchHit => hit !== null);
  }

  private async openSearch(lang: WikiLang, query: string): Promise<string[]> {
    const data = await this.api(lang, {
      action: "opensearch",
      search: query,
      limit: "5",
      namespace: "0",
      redirects: "resolve",
    });
    const titles = Array.isArray(data) ? data[1] : null;
    if (!Array.isArray(titles)) return [];
    return titles.filter((title): title is string => typeof title === "string" && title.length > 0);
  }

  private async loadPage(title: string, lang: WikiLang, section?: string): Promise<PagePayload> {
    const data = await this.api(lang, {
      action: "parse",
      page: title,
      prop: "text|displaytitle|sections",
      redirects: "1",
    });
    const error = data?.error as ApiError | undefined;
    if (error || !data?.parse) {
      return {
        title,
        lang,
        url: pageUrl(lang, title),
        infobox: [],
        markdown: error?.info || "没有找到这一页。",
        sections: [],
        truncated: false,
        missing: true,
        note: error?.code === "missingtitle" ? "页面不存在。" : error?.info,
      };
    }
    const parsedTitle = typeof data.parse.title === "string" ? data.parse.title : title;
    const html = asText(data.parse.text);
    const parsed = parseWikiHtml(html, { section });
    const apiSections = Array.isArray(data.parse.sections)
      ? data.parse.sections
          .map((sectionRow: { line?: string }) =>
            typeof sectionRow?.line === "string" ? sectionRow.line.replace(/<[^>]+>/g, "").trim() : "",
          )
          .filter(Boolean)
      : parsed.sections;
    return {
      title: parsedTitle,
      lang,
      url: pageUrl(lang, parsedTitle),
      infobox: parsed.infobox,
      markdown: parsed.markdown,
      sections: apiSections.length > 0 ? apiSections : parsed.sections,
      truncated: parsed.truncated,
      missing: false,
    };
  }

  private async counterpartOf(title: string, lang: WikiLang): Promise<Citation | undefined> {
    return this.lookupLanglink(title, lang, otherLang(lang));
  }

  private async lookupLanglink(
    title: string,
    from: WikiLang,
    to: WikiLang,
  ): Promise<Citation | undefined> {
    const data = await this.api(from, {
      action: "query",
      prop: "langlinks",
      titles: title,
      lllang: to,
      lllimit: "1",
      redirects: "1",
    });
    const pages = data?.query?.pages;
    const page = Array.isArray(pages) ? pages[0] : null;
    const link = page?.langlinks?.[0];
    if (!link || typeof link.title !== "string") return undefined;
    const lang = link.lang === "zh" || link.lang === "en" ? link.lang : to;
    return { title: link.title, lang, url: pageUrl(lang, link.title) };
  }

  private async api(lang: WikiLang, params: Record<string, string>): Promise<any> {
    const url = new URL(API[lang]);
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("maxlag", "5");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const href = url.toString();
    const cacheKey = await digestKey(href);
    const cached = await this.cache?.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Ignore a corrupt cache entry and refetch.
      }
    }
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetchImpl(href, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`wiki http ${response.status}`);
        continue;
      }
      if (!response.ok) {
        const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 180);
        console.log(JSON.stringify({ level: "warn", scope: "wiki", status: response.status, detail }));
        throw new Error(`wiki http ${response.status}`);
      }
      const data = (await response.json()) as { error?: { code?: string } };
      if (data?.error?.code === "maxlag" && attempt === 0) continue;
      if (!data?.error) {
        const ttl = params.action === "parse" || params.prop === "langlinks" ? 60 * 60 * 12 : 60 * 10;
        await this.cache?.put(cacheKey, JSON.stringify(data), ttl).catch(() => undefined);
      }
      return data;
    }
    throw lastError ?? new Error("wiki request failed");
  }
}
