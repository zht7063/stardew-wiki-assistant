import { wikiImageUrl, wikiOrigin } from "../shared/images";
import type { WikiLang } from "../shared/types";

const ICON_FILE =
  /^(?:spring|summer|fall|autumn|winter|rain|sun|snow|wind|green_?rain|energy|health|gold|silver|iridium|time(?:_icon)?|clock|bundle(?:_(?:red|purple|blue|yellow))?|yes|no|blank|link|arrow|star)(?:_small)?\.(?:png|gif|jpe?g|webp)$/i;

export function imageFileName(value: string): string {
  const cut = value.split("?")[0] ?? value;
  const base = cut.split("/").pop() ?? cut;
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    decoded = base;
  }
  return decoded.replace(/^\d+px-/, "").replace(/ /g, "_");
}

/** Season icons, currency, and other UI sprites are not the page portrait. */
export function isDecorativeImage(value: string): boolean {
  const name = imageFileName(value);
  return ICON_FILE.test(name);
}

function attr(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/** Turn a wiki img src into an absolute image URL, or null when it is not a wiki file. */
export function resolveWikiImageUrl(src: string, origin: string): string | null {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("data:")) return null;
  let absolute = "";
  if (trimmed.startsWith("//")) absolute = `https:${trimmed}`;
  else if (/^https?:\/\//i.test(trimmed)) absolute = trimmed.replace(/^http:\/\//i, "https://");
  else if (trimmed.startsWith("/")) absolute = `${origin}${trimmed}`;
  else return null;
  const safe = wikiImageUrl(absolute);
  if (!safe || isDecorativeImage(safe)) return null;
  return safe;
}

function sliceTable(html: string, openIndex: number): string | null {
  const open = /<table\b[^>]*>/i.exec(html.slice(openIndex));
  if (!open || open.index !== 0) return null;
  const lower = html.toLowerCase();
  let depth = 1;
  let cursor = openIndex + open[0].length;
  while (cursor < html.length && depth > 0) {
    const nextOpen = lower.indexOf("<table", cursor);
    const nextClose = lower.indexOf("</table>", cursor);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + 6;
      continue;
    }
    depth -= 1;
    cursor = nextClose + "</table>".length;
    if (depth === 0) return html.slice(openIndex, cursor);
  }
  return null;
}

/**
 * The portrait lives in the infobox, outside the label/value rows that hold
 * season icons and gift sprites.
 */
export function extractInfoboxImage(html: string, origin: string): string | null {
  const marker = html.search(/<table\b[^>]*\bid\s*=\s*["']infoboxtable["']/i);
  if (marker < 0) return null;
  const table = sliceTable(html, marker);
  if (!table) return null;
  const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    if (/id\s*=\s*["']infoboxdetail["']/i.test(row) || /id\s*=\s*["']infoboxsection["']/i.test(row)) continue;
    const images = row.match(/<img\b[^>]*>/gi) ?? [];
    for (const tag of images) {
      const width = Number(attr(tag, "width"));
      if (Number.isFinite(width) && width > 0 && width <= 40) continue;
      const src = attr(tag, "src");
      const resolved = src ? resolveWikiImageUrl(src, origin) : null;
      if (resolved) return resolved;
    }
  }
  return null;
}

export function imageFromApiPage(page: {
  pageimage?: unknown;
  thumbnail?: { source?: unknown };
  original?: { source?: unknown };
}): string | null {
  if (typeof page.pageimage === "string" && isDecorativeImage(page.pageimage)) return null;
  const source =
    page.thumbnail && typeof page.thumbnail.source === "string"
      ? page.thumbnail.source
      : page.original && typeof page.original.source === "string"
        ? page.original.source
        : "";
  if (!source) return null;
  return resolveWikiImageUrl(source, "https://zh.stardewvalleywiki.com");
}

function fileTitle(value: string): string {
  return value.replace(/^(?:file|image|文件|图像)\s*:\s*/i, "").trim();
}

/** Choose the portrait from MediaWiki's `prop=images` list. A pile of unrelated sprites is not a guess. */
export function pickMainFile(files: string[], hints: string[]): string | null {
  const usable = files.map(fileTitle).filter((file) => file && !isDecorativeImage(file));
  if (usable.length === 0) return null;
  const needles = hints.map((hint) => hint.trim().replace(/ /g, "_").toLowerCase()).filter((hint) => hint.length >= 2);
  for (const hint of needles) {
    const exact = usable.find((file) => imageFileName(file).replace(/\.[^.]+$/, "").toLowerCase() === hint);
    if (exact) return exact;
  }
  for (const hint of needles) {
    if ([...hint].length < 3) continue;
    const partial = usable.find((file) => {
      const stem = imageFileName(file).replace(/\.[^.]+$/, "").toLowerCase();
      return stem.includes(hint) || hint.includes(stem);
    });
    if (partial) return partial;
  }
  return usable.length === 1 ? usable[0] : null;
}

export interface StoredImageHit {
  url?: string;
  file?: string;
}

/**
 * Pull an image out of text we already saved. Current rows are cleaned
 * markdown, so this stays empty until a row actually contains HTML, wikitext,
 * or a wiki file URL.
 */
export function extractImageFromStored(
  parts: { html?: string; wikitext?: string; body?: string; infoboxJson?: string; searchText?: string },
  lang: WikiLang,
): StoredImageHit {
  const blob = [parts.html, parts.wikitext, parts.body, parts.infoboxJson, parts.searchText].filter(Boolean).join("\n");
  if (!blob.trim()) return {};
  const origin = wikiOrigin(lang);
  if (/<img\b/i.test(blob)) {
    const fromInfobox = extractInfoboxImage(blob, origin);
    if (fromInfobox) return { url: fromInfobox };
    const tags = blob.match(/<img\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
      const resolved = resolveWikiImageUrl(attr(tag, "src"), origin);
      if (resolved) return { url: resolved };
    }
  }
  const absolute = /https?:\/\/(?:zh\.)?stardewvalleywiki\.com\/mediawiki\/images\/[^\s"'<>]+/i.exec(blob);
  if (absolute?.[0]) {
    const cleaned = absolute[0].replace(/[),.;，。、）]+$/u, "");
    const url = resolveWikiImageUrl(cleaned, origin);
    if (url) return { url };
  }
  const file = /\[\[(?:File|Image|文件|图像)\s*:\s*([^\]|#]+)/i.exec(blob);
  if (file?.[1]) {
    const name = fileTitle(file[1]).replace(/ /g, "_");
    if (name && !isDecorativeImage(name)) return { file: name };
  }
  return {};
}
