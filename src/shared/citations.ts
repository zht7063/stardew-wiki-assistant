import { wikiImageUrl } from "./images";
import type { Citation, WikiLang } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Same wiki page, even when the URL spelling differs (spaces, underscores, case). */
export function citationKey(page: Citation): string {
  return `${page.lang}\0${page.title.trim().replace(/_/g, " ").toLocaleLowerCase()}`;
}

export function citationFromUnknown(page: unknown): Citation | null {
  if (!isRecord(page)) return null;
  if (typeof page.title !== "string" || typeof page.url !== "string") return null;
  if (page.lang !== "zh" && page.lang !== "en") return null;
  const lang: WikiLang = page.lang;
  const image = wikiImageUrl(typeof page.image === "string" ? page.image : null);
  return image
    ? { title: page.title, url: page.url, lang, image }
    : { title: page.title, url: page.url, lang };
}

export function dedupeCitations(pages: Citation[]): Citation[] {
  const order: string[] = [];
  const byKey = new Map<string, Citation>();
  const urlToKey = new Map<string, string>();
  for (const page of pages) {
    const key = citationKey(page);
    const urlKey = `url\0${page.url}`;
    const existingKey = byKey.has(key) ? key : urlToKey.get(urlKey);
    if (existingKey) {
      const existing = byKey.get(existingKey);
      if (existing && !existing.image && page.image) byKey.set(existingKey, { ...existing, image: page.image });
      continue;
    }
    order.push(key);
    byKey.set(key, page);
    urlToKey.set(urlKey, key);
  }
  return order.flatMap((key) => {
    const page = byKey.get(key);
    return page ? [page] : [];
  });
}
