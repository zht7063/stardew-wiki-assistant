import type { Citation } from "./types";

/** Same wiki page, even when the URL spelling differs (spaces, underscores, case). */
export function citationKey(page: Citation): string {
  return `${page.lang}\0${page.title.trim().replace(/_/g, " ").toLocaleLowerCase()}`;
}

export function dedupeCitations(pages: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const page of pages) {
    const key = citationKey(page);
    const urlKey = `url\0${page.url}`;
    if (seen.has(key) || seen.has(urlKey)) continue;
    seen.add(key);
    seen.add(urlKey);
    out.push(page);
  }
  return out;
}
