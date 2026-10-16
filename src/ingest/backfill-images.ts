import { createHash } from "node:crypto";
import { wikiImageUrl, wikiOrigin } from "../shared/images";
import type { WikiLang } from "../shared/types";
import type { SqlExecutor, SqlStatement } from "../wiki/index-store";
import { extractImageFromStored, pickMainFile } from "../wiki/image";
import type { MediaWiki } from "./mediawiki";
import { ensureImageColumn } from "./pipeline";

const UPDATE_IMAGE = `UPDATE pages SET image_url = ? WHERE lang = ? AND title = ? AND (image_url IS NULL OR image_url = '')`;

interface ImageRow {
  lang: string;
  title: string;
  body: string;
  infobox_json: string;
  search_text: string;
  counterpart_title: string | null;
}

export interface StoredBackfillStats {
  scanned: number;
  fromStored: number;
  stillMissing: number;
}

export function mediawikiFileUrl(lang: WikiLang, filename: string): string | null {
  const name = filename
    .trim()
    .replace(/^(?:file|image|文件|图像)\s*:\s*/i, "")
    .replace(/ /g, "_")
    .replace(/^.*[/\\]/, "");
  if (!name || name.includes("..") || name.length > 240) return null;
  const hash = createHash("md5").update(name).digest("hex");
  const first = hash[0];
  const second = hash.slice(0, 2);
  if (!first) return null;
  return wikiImageUrl(`${wikiOrigin(lang)}/mediawiki/images/${first}/${second}/${encodeURIComponent(name)}`);
}

async function nextEmpty(sql: SqlExecutor, lang: string, title: string): Promise<ImageRow[]> {
  return sql.all<ImageRow>(
    `SELECT lang, title, body, infobox_json, search_text, counterpart_title
     FROM pages
     WHERE (image_url IS NULL OR image_url = '')
       AND (lang > ? OR (lang = ? AND title > ?))
     ORDER BY lang, title
     LIMIT 20`,
    [lang, lang, title],
  );
}

async function writeImages(sql: SqlExecutor, statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;
  if (sql.batch) await sql.batch(statements);
  else {
    for (const statement of statements) await sql.run(statement.sql, statement.params);
  }
}

/** Fill image_url from HTML, wikitext, or file URLs already saved on the row. Does not call the wiki. */
export async function backfillStoredImages(sql: SqlExecutor): Promise<StoredBackfillStats> {
  await ensureImageColumn(sql);
  let scanned = 0;
  let fromStored = 0;
  let lang = "";
  let title = "";
  for (;;) {
    const rows = await nextEmpty(sql, lang, title);
    if (rows.length === 0) break;
    const statements: SqlStatement[] = [];
    for (const row of rows) {
      scanned += 1;
      lang = row.lang;
      title = row.title;
      if (row.lang !== "zh" && row.lang !== "en") continue;
      const hit = extractImageFromStored(
        { body: row.body, infoboxJson: row.infobox_json, searchText: row.search_text },
        row.lang,
      );
      const url = hit.url ?? (hit.file ? mediawikiFileUrl(row.lang, hit.file) : null);
      if (!url) continue;
      statements.push({ sql: UPDATE_IMAGE, params: [url, row.lang, row.title] });
    }
    await writeImages(sql, statements);
    fromStored += statements.length;
  }
  return { scanned, fromStored, stillMissing: scanned - fromStored };
}

/**
 * Ask the wiki for portraits without re-downloading page HTML.
 * pageimages when the module exists, otherwise the core file list plus the
 * standard MediaWiki hash path. Run this from a machine the wiki does not challenge.
 */
export async function backfillApiImages(sql: SqlExecutor, wiki: MediaWiki): Promise<{ fromApi: number }> {
  await ensureImageColumn(sql);
  let fromApi = 0;
  let lang = "";
  let title = "";
  for (;;) {
    const rows = await nextEmpty(sql, lang, title);
    if (rows.length === 0) break;
    const byLang = new Map<WikiLang, ImageRow[]>();
    for (const row of rows) {
      lang = row.lang;
      title = row.title;
      if (row.lang !== "zh" && row.lang !== "en") continue;
      const group = byLang.get(row.lang) ?? [];
      group.push(row);
      byLang.set(row.lang, group);
    }
    for (const [pageLang, group] of byLang) {
      const metas = await wiki.describe(
        pageLang,
        group.map((row) => row.title),
      );
      const known = new Map(metas.map((meta) => [meta.title, meta.imageUrl]));
      const statements: SqlStatement[] = [];
      const unresolved: ImageRow[] = [];
      for (const row of group) {
        const image = known.get(row.title);
        if (image) statements.push({ sql: UPDATE_IMAGE, params: [image, pageLang, row.title] });
        else unresolved.push(row);
      }
      if (unresolved.length > 0) {
        const files = await wiki.listImages(
          pageLang,
          unresolved.map((row) => row.title),
        );
        for (const row of unresolved) {
          const picked = pickMainFile(files.get(row.title) ?? [], [row.title, row.counterpart_title ?? ""]);
          const url = picked ? mediawikiFileUrl(pageLang, picked) : null;
          if (url) statements.push({ sql: UPDATE_IMAGE, params: [url, pageLang, row.title] });
        }
      }
      await writeImages(sql, statements);
      fromApi += statements.length;
    }
  }
  return { fromApi };
}
