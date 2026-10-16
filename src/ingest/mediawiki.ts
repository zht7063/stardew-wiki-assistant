import type { Citation, WikiLang } from "../shared/types";
import { USER_AGENT, pageUrl } from "../wiki/client";
import { imageFromApiPage } from "../wiki/image";

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
  /** Portrait from pageimages, when that module is installed. */
  imageUrl?: string;
}

export type WikiFetch = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface MediaWikiOptions {
  /** How many wiki requests may be in flight at once. Capped at 4. */
  concurrency?: number;
  /** First retry waits this long, then doubles. Tests pass 0. */
  retryBaseMs?: number;
  attempts?: number;
}

/**
 * MediaWiki Action API client for ingest. Uses whatever fetch it is given;
 * the CLI passes an HTTP/2 undici fetch because this wiki challenges HTTP/1.1.
 * Requests are spaced by `pauseMs` and capped at a few in flight.
 */
export class MediaWiki {
  private readonly gate: RequestGate;
  private readonly attempts: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly fetchImpl: WikiFetch,
    private readonly pauseMs = 100,
    options: MediaWikiOptions = {},
  ) {
    const concurrency = Math.min(4, Math.max(1, options.concurrency ?? 3));
    this.gate = new RequestGate(concurrency, pauseMs);
    this.attempts = Math.max(1, options.attempts ?? 5);
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 400);
  }

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
    const base = {
      action: "query",
      titles: titles.join("|"),
      lllang: other,
      lllimit: "1",
      redirects: "0",
    };
    // pageimages is optional on this wiki. If the module is missing, the query
    // comes back without pages and we retry the call the ingest already depends on.
    let data = await this.api(lang, {
      ...base,
      prop: "info|langlinks|pageimages",
      piprop: "thumbnail|original|name",
      pithumbsize: "320",
      pilicense: "any",
    });
    if (!Array.isArray(data?.query?.pages)) {
      data = await this.api(lang, { ...base, prop: "info|langlinks" });
    }
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
      const imageUrl = imageFromApiPage(page) ?? undefined;
      metas.push({
        title: page.title,
        revId: typeof page.lastrevid === "number" ? page.lastrevid : 0,
        counterpart,
        imageUrl,
      });
    }
    return metas;
  }

  /**
   * Core `prop=images` list. Used by the image backfill when pageimages is
   * absent and we do not want to re-download rendered HTML.
   */
  async listImages(lang: WikiLang, titles: string[]): Promise<Map<string, string[]>> {
    if (titles.length === 0) return new Map();
    const data = await this.api(lang, {
      action: "query",
      prop: "images",
      titles: titles.join("|"),
      imlimit: "20",
      redirects: "0",
    });
    const pages = data?.query?.pages;
    const out = new Map<string, string[]>();
    if (!Array.isArray(pages)) return out;
    for (const page of pages) {
      if (!page || typeof page.title !== "string" || !Array.isArray(page.images)) continue;
      const files = page.images.flatMap((image: { title?: unknown }) => (typeof image?.title === "string" ? [image.title] : []));
      out.set(page.title, files);
    }
    return out;
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
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      await this.gate.acquire();
      let retry = false;
      try {
        let response: { status: number; ok: boolean; text(): Promise<string> };
        try {
          response = await this.fetchImpl(url.toString(), {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          });
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("fetch failed");
          retry = true;
          response = { status: 0, ok: false, text: async () => "" };
        }
        if (retry) {
          // The fetch itself failed. Back off below, outside the gate.
        } else {
          const text = await response.text();
          if (response.status === 403 || text.includes("Just a moment")) throw new WikiBlockedError();
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error(`wiki http ${response.status}`);
            retry = true;
          } else if (!response.ok) {
            throw new Error(`wiki http ${response.status}`);
          } else {
            try {
              const data = JSON.parse(text) as { error?: { code?: string; info?: string } };
              if (data?.error?.code === "maxlag") {
                lastError = new Error(data.error.info || "maxlag");
                retry = true;
              } else {
                return data;
              }
            } catch (error) {
              if (error instanceof WikiBlockedError) throw error;
              lastError = error instanceof Error ? error : new Error("wiki response was not json");
              retry = true;
            }
          }
        }
      } finally {
        this.gate.release();
      }
      if (!retry) break;
      await sleep(this.retryBaseMs * 2 ** attempt);
    }
    throw lastError ?? new Error("wiki request failed");
  }
}

/** Spaces request starts and caps how many wiki calls run at once. */
class RequestGate {
  private active = 0;
  private waiters: Array<() => void> = [];
  private nextStart = 0;

  constructor(
    private readonly concurrency: number,
    private readonly intervalMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, this.nextStart - now);
    this.nextStart = Math.max(this.nextStart, now) + this.intervalMs;
    if (wait > 0) await sleep(wait);
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const wake = this.waiters.shift();
    if (wake) wake();
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
