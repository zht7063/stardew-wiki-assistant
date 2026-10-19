import { wikiImageUrl, wikiOrigin } from "../shared/images";
import type { Citation, WikiLang } from "../shared/types";
import { extractInfoboxImage } from "./image";
import type { InfoboxField } from "./parse";
import { parseWikiHtml } from "./parse";

/** Stored body cap. D1 rejects SQL statements around 100KB, and Chinese is 3 bytes per character. */
export const BODY_LIMIT = 24_000;
export const SEARCH_LIMIT = 4_000;
export const VECTOR_LIMIT = 1_500;
export const TOOL_LIMIT = 7_000;

export interface StoredPage {
  lang: WikiLang;
  title: string;
  url: string;
  revId: number;
  counterpart?: Citation;
  infobox: InfoboxField[];
  sections: string[];
  /** Text indexed by FTS: title, counterpart title, infobox, and the start of the body. */
  searchText: string;
  body: string;
  truncated: boolean;
  /** Absolute wiki file URL for the infobox portrait, when we could find one. */
  imageUrl?: string;
  /** Hash of the stored fields. Ingest skips the D1 write when it matches pages.content_hash. */
  contentHash?: string;
}

export function toStoredPage(input: {
  lang: WikiLang;
  title: string;
  url: string;
  revId: number;
  html: string;
  counterpart?: Citation;
  /** pageimages (or another API) result, used when the infobox HTML has no portrait. */
  imageUrl?: string;
}): StoredPage {
  const parsed = parseWikiHtml(input.html, { maxChars: BODY_LIMIT });
  const searchText = [
    input.title,
    input.counterpart?.title ?? "",
    ...parsed.infobox.map((field) => `${field.label} ${field.value}`),
    parsed.markdown,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, SEARCH_LIMIT);
  const imageUrl = extractInfoboxImage(input.html, wikiOrigin(input.lang)) ?? wikiImageUrl(input.imageUrl) ?? undefined;
  return {
    lang: input.lang,
    title: input.title,
    url: input.url,
    revId: input.revId,
    counterpart: input.counterpart,
    infobox: parsed.infobox,
    sections: parsed.sections,
    searchText,
    body: parsed.markdown,
    truncated: parsed.truncated,
    imageUrl,
  };
}

export function vectorText(page: StoredPage): string {
  return page.searchText.slice(0, VECTOR_LIMIT);
}

export function sliceMarkdownSection(markdown: string, section: string): { markdown: string; found: boolean } {
  const wanted = section.trim();
  if (!wanted) return { markdown, found: false };
  const lines = markdown.split("\n");
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[index] ?? "");
    if (!match?.[1] || !match[2]) continue;
    const text = match[2].trim();
    if (start < 0 && (text === wanted || text.includes(wanted))) {
      start = index;
      level = match[1].length;
      continue;
    }
    if (start >= 0 && match[1].length <= level) {
      return { markdown: lines.slice(start, index).join("\n").trim(), found: true };
    }
  }
  if (start >= 0) return { markdown: lines.slice(start).join("\n").trim(), found: true };
  return { markdown: "", found: false };
}

export function capForTool(markdown: string): { markdown: string; truncated: boolean } {
  if (markdown.length <= TOOL_LIMIT) return { markdown, truncated: false };
  const cut = markdown.lastIndexOf("\n", TOOL_LIMIT);
  const sliced = markdown.slice(0, cut > 400 ? cut : TOOL_LIMIT).trim();
  return { markdown: `${sliced}\n\n（这一页比较长，先看到这里。可以用 section 指定章节。）`, truncated: true };
}
