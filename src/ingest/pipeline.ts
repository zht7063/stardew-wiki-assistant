import { createHash } from "node:crypto";
import type { WikiLang } from "../shared/types";
import type { SqlExecutor } from "../wiki/index-store";
import { upsertStoredPage } from "../wiki/index-store";
import { pageUrl } from "../wiki/client";
import { toStoredPage, vectorText, type StoredPage } from "../wiki/record";
import { SCHEMA_STATEMENTS } from "../wiki/schema";
import { MediaWiki, type PageMeta } from "./mediawiki";

export interface IngestTarget {
  getRev(lang: WikiLang, title: string): Promise<number | null>;
  put(page: StoredPage): Promise<void>;
  putVector?(id: string, values: number[], metadata: { lang: string; title: string }): Promise<void>;
}

export interface IngestStats {
  seen: number;
  updated: number;
  skipped: number;
}

export function vectorId(lang: string, title: string): string {
  return createHash("sha256").update(`${lang}\0${title}`).digest("hex").slice(0, 32);
}

export async function applySchema(sql: SqlExecutor): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) await sql.run(statement, []);
}

export function targetFromSql(sql: SqlExecutor): IngestTarget {
  return {
    async getRev(lang, title) {
      const rows = await sql.all<{ rev_id: number }>(`SELECT rev_id FROM pages WHERE lang = ? AND title = ?`, [lang, title]);
      const rev = rows[0]?.rev_id;
      return typeof rev === "number" ? rev : null;
    },
    put(page) {
      return upsertStoredPage(sql, page);
    },
  };
}

export async function ingestWiki(options: {
  wiki: MediaWiki;
  target: IngestTarget;
  langs: WikiLang[];
  limit?: number;
  embed?: (texts: string[]) => Promise<number[][]>;
  onProgress?: (message: string) => void;
}): Promise<IngestStats> {
  const stats: IngestStats = { seen: 0, updated: 0, skipped: 0 };
  const log = options.onProgress ?? (() => undefined);
  let vectorsDisabled = false;
  for (const lang of options.langs) {
    const titles = await options.wiki.listTitles(lang, options.limit);
    log(`${lang}: ${titles.length} titles`);
    for (const batch of chunks(titles, 15)) {
      const metas = await options.wiki.describe(lang, batch);
      const written: StoredPage[] = [];
      for (const meta of metas) stats.seen += 1;
      for (const meta of orderMetas(batch, metas)) {
        const rev = await options.target.getRev(lang, meta.title);
        if (rev !== null && rev === meta.revId && meta.revId !== 0) {
          stats.skipped += 1;
          continue;
        }
        const rendered = await options.wiki.render(lang, meta.title);
        if (!rendered) {
          log(`skip ${lang}:${meta.title} (no parse)`);
          continue;
        }
        const page = toStoredPage({
          lang,
          title: rendered.title,
          url: pageUrl(lang, rendered.title),
          revId: meta.revId,
          html: rendered.html,
          counterpart: meta.counterpart,
        });
        await options.target.put(page);
        written.push(page);
        stats.updated += 1;
        if (stats.updated % 25 === 0) log(`updated ${stats.updated}, skipped ${stats.skipped}`);
      }
      if (written.length > 0 && options.embed && options.target.putVector && !vectorsDisabled) {
        try {
          await embedPages(written, options.embed, options.target.putVector);
        } catch (error) {
          vectorsDisabled = true;
          const message = error instanceof Error ? error.message : "embed failed";
          log(`embeddings stopped (${message}). Keyword pages are still saved.`);
        }
      }
    }
  }
  return stats;
}

async function embedPages(
  pages: StoredPage[],
  embed: (texts: string[]) => Promise<number[][]>,
  putVector: NonNullable<IngestTarget["putVector"]>,
): Promise<void> {
  for (const group of chunks(pages, 8)) {
    const matrix = await embed(group.map((page) => vectorText(page)));
    for (let index = 0; index < group.length; index += 1) {
      const values = matrix[index];
      const page = group[index];
      if (!values || values.length === 0 || !page) continue;
      await putVector(vectorId(page.lang, page.title), values, { lang: page.lang, title: page.title });
    }
  }
}

function orderMetas(titles: string[], metas: PageMeta[]): PageMeta[] {
  const byTitle = new Map(metas.map((meta) => [meta.title, meta]));
  const ordered: PageMeta[] = [];
  for (const title of titles) {
    const meta = byTitle.get(title);
    if (meta) ordered.push(meta);
  }
  return ordered;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
