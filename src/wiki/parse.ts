/**
 * Turn MediaWiki's rendered HTML into readable markdown.
 *
 * The Stardew wikis expand templates ({{Name}}, {{Season}}, infoboxes) only
 * when MediaWiki parses the page, so Chinese item names show up in the HTML
 * and not in the raw wikitext. This cleaner keeps infobox fields and tables,
 * and drops navboxes, edit links, images, and reference markers.
 *
 * Parsing ideas — infobox field extraction, readable tables, and stripping
 * file/nav noise — follow the approach in cbhl/farming-game-mcp and
 * vehemont/sdv-mcp, applied to HTML instead of a dump of wikitext.
 */

export interface InfoboxField {
  label: string;
  value: string;
}

export interface ParsedWikiHtml {
  infobox: InfoboxField[];
  markdown: string;
  sections: string[];
  truncated: boolean;
}

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#160": " ",
  "#8201": " ",
  "#8202": " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY[entity] ?? match;
  });
}

function tidySpaces(value: string): string {
  return value
    .replace(/[\u00a0\u2009\u200a\u202f]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Visible text of an HTML fragment, with images and reference markers removed. */
export function htmlToInline(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<sup\b[\s\S]*?<\/sup>/gi, "");
  s = s.replace(/<img\b[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  return tidySpaces(decodeEntities(s));
}

function anchorTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const text = htmlToInline(match[1] ?? "");
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function fieldValue(cellHtml: string): string {
  const anchors = anchorTexts(cellHtml);
  if (anchors.length >= 3) return anchors.join("、");
  return htmlToInline(cellHtml).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

function findMatchingClose(html: string, openIndex: number, tag: string): number {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`</${tag}>`, "gi");
  openRe.lastIndex = openIndex;
  const first = openRe.exec(html);
  if (!first || first.index !== openIndex) return -1;
  let depth = 1;
  let cursor = first.index + first[0].length;
  while (cursor < html.length && depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) return cursor;
  }
  return -1;
}

function removeByClass(html: string, className: string): string {
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, "gi");
  let result = "";
  let cursor = 0;
  for (const match of html.matchAll(re)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const tag = match[1] ?? "div";
    const end = findMatchingClose(html, start, tag);
    result += html.slice(cursor, start);
    cursor = end > start ? end : start + match[0].length;
  }
  result += html.slice(cursor);
  return result;
}

function extractInfobox(html: string): { html: string; fields: InfoboxField[] } {
  const marker = html.search(/<table\b[^>]*id="infoboxtable"/i);
  if (marker < 0) return { html, fields: [] };
  const end = findMatchingClose(html, marker, "table");
  if (end < 0) return { html, fields: [] };
  const table = html.slice(marker, end);
  const fields: InfoboxField[] = [];
  const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const labelMatch = row.match(/<td\b[^>]*id="infoboxsection"[^>]*>([\s\S]*?)<\/td>/i);
    const valueMatch = row.match(/<td\b[^>]*id="infoboxdetail"[^>]*>([\s\S]*?)<\/td>/i);
    if (!labelMatch || !valueMatch) continue;
    const label = htmlToInline(labelMatch[1] ?? "");
    const value = fieldValue(valueMatch[1] ?? "");
    if (!label || !value || label === "信息") continue;
    fields.push({ label, value });
  }
  return { html: html.slice(0, marker) + html.slice(end), fields };
}

interface HeadingHit {
  level: number;
  text: string;
  index: number;
  tagEnd: number;
}

function headings(html: string): HeadingHit[] {
  const hits: HeadingHit[] = [];
  const re = /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi;
  for (const match of html.matchAll(re)) {
    const full = match[0];
    const index = match.index ?? 0;
    const headline = full.match(/<span\b[^>]*class="mw-headline"[^>]*>([\s\S]*?)<\/span>/i);
    const text = htmlToInline(headline?.[1] ?? full);
    if (!text) continue;
    hits.push({ level: Number(match[1]), text, index, tagEnd: index + full.length });
  }
  return hits;
}

function normalizeHeading(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function sliceSection(html: string, section: string): { html: string; found: boolean } {
  const wanted = normalizeHeading(section);
  if (!wanted) return { html, found: true };
  const hits = headings(html);
  const match =
    hits.find((hit) => normalizeHeading(hit.text) === wanted) ??
    hits.find((hit) => normalizeHeading(hit.text).includes(wanted));
  if (!match) return { html, found: false };
  const next = hits.find((hit) => hit.index > match.index && hit.level <= match.level);
  const end = next ? next.index : html.length;
  return { html: html.slice(match.index, end), found: true };
}

function splitRows(tableHtml: string): string[] {
  const rows: string[] = [];
  const re = /<tr\b[^>]*>/gi;
  const starts = [...tableHtml.matchAll(re)].map((match) => match.index ?? 0);
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] ?? 0;
    const end = findMatchingClose(tableHtml, start, "tr");
    if (end > start) rows.push(tableHtml.slice(start, end));
  }
  return rows;
}

function splitCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<(td|th)\b[^>]*>/gi;
  for (const match of rowHtml.matchAll(re)) {
    const start = match.index ?? 0;
    const tag = match[1] ?? "td";
    const end = findMatchingClose(rowHtml, start, tag);
    if (end > start) cells.push(rowHtml.slice(start, end));
  }
  return cells;
}

function tableToMarkdown(tableHtml: string): string {
  const rows = splitRows(tableHtml)
    .map((row) =>
      splitCells(row).map((cell) =>
        htmlToInline(cell).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim(),
      ),
    )
    .filter((row) => row.some(Boolean));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const copy = row.slice();
    while (copy.length < width) copy.push("");
    return copy;
  });
  const header = normalized[0] ?? [];
  const body = normalized.slice(1);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function replaceTables(html: string): string {
  let result = "";
  let cursor = 0;
  const re = /<table\b[^>]*>/gi;
  for (const match of html.matchAll(re)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const end = findMatchingClose(html, start, "table");
    if (end < 0) break;
    const inner = html.slice(start, end);
    const nestedStart = inner.slice(match[0].length).search(/<table\b/i);
    const markdown =
      nestedStart >= 0
        ? tableToMarkdown(inner.slice(0, match[0].length) + replaceTables(inner.slice(match[0].length)))
        : tableToMarkdown(inner);
    result += html.slice(cursor, start);
    result += `\n${markdown}\n`;
    cursor = end;
  }
  result += html.slice(cursor);
  return result;
}

function htmlToMarkdown(html: string): string {
  let s = replaceTables(html);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
    const text = htmlToInline(inner);
    return text ? `\n${"#".repeat(Number(level))} ${text}\n` : "\n";
  });
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|ul|ol|blockquote|table)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = tidySpaces(decodeEntities(s));
  s = s
    .split("\n")
    .filter((line) => line.trim() !== "编辑")
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

export function parseWikiHtml(
  html: string,
  options: { section?: string; maxChars?: number } = {},
): ParsedWikiHtml {
  const maxChars = options.maxChars ?? 7000;
  let source = html.replace(/<!--[\s\S]*?-->/g, "");
  source = source.replace(/<script[\s\S]*?<\/script>/gi, "");
  source = source.replace(/<style[\s\S]*?<\/style>/gi, "");
  source = removeByClass(source, "mw-editsection");
  source = removeByClass(source, "toc");
  source = removeByClass(source, "navbox");
  const extracted = extractInfobox(source);
  source = extracted.html;
  const sections = headings(source).map((hit) => hit.text);
  let found = true;
  if (options.section) {
    const sliced = sliceSection(source, options.section);
    source = sliced.html;
    found = sliced.found;
  }
  let markdown = htmlToMarkdown(source);
  if (options.section && !found) {
    markdown = `没有名为「${options.section}」的章节。可试：${sections.slice(0, 20).join("、") || "（这一页没有章节）"}`;
  }
  let truncated = false;
  if (markdown.length > maxChars) {
    truncated = true;
    const cut = markdown.lastIndexOf("\n", maxChars);
    markdown = markdown.slice(0, cut > 400 ? cut : maxChars).trim();
    const hint = sections.slice(0, 20).join("、");
    markdown += `\n\n（这一页比较长，先看到这里。可以用 section 指定章节${hint ? `，例如 ${hint}` : ""}。）`;
  }
  return { infobox: extracted.fields, markdown, sections, truncated };
}

/** Question words that make the wiki's AND search miss the actual page. */
const FILLERS = [
  "请问",
  "帮我看看",
  "帮我查",
  "帮我",
  "告诉我",
  "我想知道",
  "想知道",
  "什么",
  "怎么",
  "如何",
  "哪些",
  "哪种",
  "为什么",
  "哪里",
  "哪个",
  "是否",
  "可以",
  "一下",
  "吗",
  "呢",
  "啊",
  "呀",
  "的",
];

/** Short search strings to try, most specific first. */
export function queryCandidates(query: string): string[] {
  const raw = query.trim();
  if (!raw) return [];
  let relaxed = raw;
  for (const filler of FILLERS) relaxed = relaxed.split(filler).join("");
  relaxed = relaxed.replace(/[？?！!。，,、\s]/g, "").trim();
  const candidates = [raw];
  if (relaxed && relaxed !== raw) candidates.push(relaxed);
  const cjk = relaxed.match(/[\u4e00-\u9fff]+/)?.[0];
  if (cjk && cjk.length > 4) candidates.push(cjk.slice(0, 4));
  const english = raw.split(/\s+/).find((word) => /[A-Za-z]{3,}/.test(word));
  if (english) candidates.push(english.replace(/[？?！!.,]/g, ""));
  const unique: string[] = [];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (value && !unique.includes(value)) unique.push(value);
  }
  return unique.slice(0, 4);
}
