import type { Citation, WikiLang } from "../shared/types";
import { USER_AGENT, pageUrl } from "../wiki/client";

const API: Record<WikiLang, string> = {
  zh: "https://zh.stardewvalleywiki.com/mediawiki/api.php",
  en: "https://stardewvalleywiki.com/mediawiki/api.php",
};

export class WikiBlockedError extends Error {
  constructor() {
    super(
      "The wiki returned a Cloudflare challenge (HTTP 403). GitHub-hosted runners are often blocked the same way Workers are. Run this command on your own computer instead: npm run ingest -- --target remote",
    );
    this.name = "WikiBlockedError";
  }
}

export interface PageMeta {
  title: string;
  revId: number;
  counterpart?: Citation;
}

export type WikiFetch = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/**
 * MediaWiki Action API client for ingest. Uses whatever fetch it is given;
 * the CLI passes an HTTP/2 undici fetch because this wiki challenges HTTP/1.1.
 */
export class MediaWiki {
  constructor(
    private readonly fetchImpl: WikiFetch,
    private readonly pauseMs = 250,
  ) {}

  async listTitles(lang: WikiLang, limit?: number): Promise<string[]> {
    const titles: string[] = [];
    let cont = "";
    while (limit === undefined || titles.length < limit) {
      const data = await this.api(lang, {
        action: "query",
        list: "allpages",
        apnamespace: "0",
        apfilterredir: "nonredirects",
        aplimit: "50",
        ...(cont ? { apcontinue: cont } : {}),
      });
      const batch = data?.query?.allpages;
      if (!Array.isArray(batch)) break;
      for (const row of batch) {
        if (typeof row?.title === "string") titles.push(row.title);
        if (limit !== undefined && titles.length >= limit) break;
      }
      const next = data?.continue?.apcontinue;
      if (typeof next !== "string" || !next) break;
      cont = next;
    }
    return titles;
  }

  async describe(lang: WikiLang, titles: string[]): Promise<PageMeta[]> {
    if (titles.length === 0) return [];
    const other = lang === "zh" ? "en" : "zh";
    const data = await this.api(lang, {
      action: "query",
      prop: "info|langlinks",
      titles: titles.join("|"),
      lllang: other,
      lllimit: "1",
      redirects: "0",
    });
    const pages = data?.query?.pages;
    if (!Array.isArray(pages)) return [];
    const metas: PageMeta[] = [];
    for (const page of pages) {
      if (!page || page.missing || typeof page.title !== "string") continue;
      const link = page.langlinks?.[0];
      let counterpart: Citation | undefined;
      if (link && typeof link.title === "string") {
        const linkLang = link.lang === "zh" || link.lang === "en" ? link.lang : other;
        counterpart = { lang: linkLang, title: link.title, url: pageUrl(linkLang, link.title) };
      }
      metas.push({
        title: page.title,
        revId: typeof page.lastrevid === "number" ? page.lastrevid : 0,
        counterpart,
      });
    }
    return metas;
  }

  async render(lang: WikiLang, title: string): Promise<{ title: string; html: string } | null> {
    const data = await this.api(lang, {
      action: "parse",
      page: title,
      prop: "text|displaytitle",
      redirects: "1",
    });
    if (data?.error || !data?.parse) return null;
    const html = asText(data.parse.text);
    if (!html) return null;
    const parsedTitle = typeof data.parse.title === "string" ? data.parse.title : title;
    return { title: parsedTitle, html };
  }

  private async api(lang: WikiLang, params: Record<string, string>): Promise<any> {
    const url = new URL(API[lang]);
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("maxlag", "5");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.pauseMs > 0) await sleep(this.pauseMs);
      const response = await this.fetchImpl(url.toString(), {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      const text = await response.text();
      if (response.status === 403 || text.includes("Just a moment")) throw new WikiBlockedError();
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`wiki http ${response.status}`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`wiki http ${response.status}`);
      const data = JSON.parse(text) as { error?: { code?: string; info?: string } };
      if (data?.error?.code === "maxlag") {
        lastError = new Error(data.error.info || "maxlag");
        await sleep(2000);
        continue;
      }
      return data;
    }
    throw lastError ?? new Error("wiki request failed");
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "*" in value && typeof value["*"] === "string") return value["*"];
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
