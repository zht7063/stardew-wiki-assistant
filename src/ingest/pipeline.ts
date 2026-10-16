import { createHash } from "node:crypto";
import type { WikiLang } from "../shared/types";
import type { SqlExecutor } from "../wiki/index-store";
import { upsertStoredPage, upsertStoredPages } from "../wiki/index-store";
import { pageUrl } from "../wiki/client";
import { toStoredPage, vectorText, type StoredPage } from "../wiki/record";
import { SCHEMA_STATEMENTS } from "../wiki/schema";
import { MediaWiki, WikiBlockedError, type PageMeta } from "./mediawiki";

export interface VectorWrite {
  id: string;
  values: number[];
  metadata: { lang: string; title: string };
}

export interface IngestTarget {
  getRev(lang: WikiLang, title: string): Promise<number | null>;
  listRevs?(lang: WikiLang): Promise<Map<string, number>>;
  put(page: StoredPage): Promise<void>;
  putMany?(pages: StoredPage[]): Promise<void>;
  putVector?(id: string, values: number[], metadata: { lang: string; title: string }): Promise<void>;
  putVectors?(items: VectorWrite[]): Promise<void>;
}

export interface IngestStats {
  seen: number;
  updated: number;
  skipped: number;
  failed: number;
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
    putMany(pages) {
      return upsertStoredPages(sql, pages);
    },
    async listRevs(lang) {
      const rows = await sql.all<{ title: string; rev_id: number }>(
        `SELECT title, rev_id FROM pages WHERE lang = ?`,
        [lang],
      );
      return new Map(rows.map((row) => [row.title, row.rev_id]));
    },
  };
}

export async function ingestWiki(options: {
  wiki: MediaWiki;
  target: IngestTarget;
  langs: WikiLang[];
  limit?: number;
  concurrency?: number;
  embed?: (texts: string[]) => Promise<number[][]>;
  onProgress?: (message: string) => void;
}): Promise<IngestStats> {
  const stats: IngestStats = { seen: 0, updated: 0, skipped: 0, failed: 0 };
  const log = options.onProgress ?? (() => undefined);
  const concurrency = Math.min(4, Math.max(1, options.concurrency ?? 3));
  let vectorsDisabled = false;
  let embedTail: Promise<void> = Promise.resolve();
  const canEmbed = Boolean(options.embed && (options.target.putVectors || options.target.putVector));
  for (const lang of options.langs) {
    const titles = await options.wiki.listTitles(lang, options.limit);
    log(`${lang}: ${titles.length} titles`);
    const known = options.target.listRevs ? await options.target.listRevs(lang) : null;
    for (const batch of chunks(titles, 20)) {
      let metas: PageMeta[] = [];
      try {
        metas = await options.wiki.describe(lang, batch);
      } catch (error) {
        if (error instanceof WikiBlockedError) throw error;
        stats.seen += batch.length;
        stats.failed += batch.length;
        log(`describe failed (${error instanceof Error ? error.message : "fetch failed"})`);
        continue;
      }
      const pending: PageMeta[] = [];
      for (const meta of orderMetas(batch, metas)) {
        stats.seen += 1;
        const rev = known ? (known.get(meta.title) ?? null) : await options.target.getRev(lang, meta.title);
        if (rev !== null && rev === meta.revId && meta.revId !== 0) {
          stats.skipped += 1;
          continue;
        }
        pending.push(meta);
      }
      const rendered = await mapPool(pending, concurrency, async (meta) => {
        try {
          const page = await options.wiki.render(lang, meta.title);
          if (!page) {
            log(`skip ${lang}:${meta.title} (no parse)`);
            return null;
          }
          return toStoredPage({
            lang,
            title: page.title,
            url: pageUrl(lang, page.title),
            revId: meta.revId,
            html: page.html,
            counterpart: meta.counterpart,
          });
        } catch (error) {
          if (error instanceof WikiBlockedError) throw error;
          stats.failed += 1;
          log(`failed ${lang}:${meta.title} (${error instanceof Error ? error.message : "fetch failed"})`);
          return null;
        }
      });
      const written = rendered.filter((page): page is StoredPage => page !== null);
      if (written.length > 0) {
        if (options.target.putMany) await options.target.putMany(written);
        else {
          for (const page of written) await options.target.put(page);
        }
        if (known) {
          for (const page of written) known.set(page.title, page.revId);
        }
        const before = stats.updated;
        stats.updated += written.length;
        if (Math.floor(before / 25) !== Math.floor(stats.updated / 25)) {
          log(`updated ${stats.updated}, skipped ${stats.skipped}, failed ${stats.failed}`);
        }
      }
      if (written.length > 0 && canEmbed && options.embed) {
        const pages = written.slice();
        const embed = options.embed;
        embedTail = embedTail.then(async () => {
          if (vectorsDisabled) return;
          try {
            await embedPages(pages, embed, options.target);
          } catch (error) {
            vectorsDisabled = true;
            const message = error instanceof Error ? error.message : "embed failed";
            log(`embeddings stopped (${message}). Keyword pages are still saved.`);
          }
        });
      }
    }
  }
  await embedTail;
  return stats;
}

async function embedPages(
  pages: StoredPage[],
  embed: (texts: string[]) => Promise<number[][]>,
  target: IngestTarget,
): Promise<void> {
  for (const group of chunks(pages, 16)) {
    const matrix = await embed(group.map((page) => vectorText(page)));
    const items: VectorWrite[] = [];
    for (let index = 0; index < group.length; index += 1) {
      const values = matrix[index];
      const page = group[index];
      if (!values || values.length === 0 || !page) continue;
      items.push({ id: vectorId(page.lang, page.title), values, metadata: { lang: page.lang, title: page.title } });
    }
    if (items.length === 0) continue;
    if (target.putVectors) await target.putVectors(items);
    else if (target.putVector) {
      for (const item of items) await target.putVector(item.id, item.values, item.metadata);
    }
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), Math.max(items.length, 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
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
