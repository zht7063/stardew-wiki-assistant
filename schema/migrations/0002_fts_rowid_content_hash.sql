-- Key pages_fts by pages.rowid and add pages.content_hash.
--
-- Why: ingest used to run `DELETE FROM pages_fts WHERE title = ? AND lang = ?` for every
-- page. FTS5 cannot use an index for `=` on its columns, so each delete scanned the whole
-- FTS table (~4k rows). After this migration ingest deletes/inserts by rowid (a few reads
-- per page) and skips pages whose rendered content hash has not changed.
--
-- Apply once, after merging and before the next remote ingest:
--   npx wrangler d1 execute stardew-wiki --remote --file schema/migrations/0002_fts_rowid_content_hash.sql
--
-- Cost on the live DB (~4,001 pages): ~4k rows read (one pass over pages) plus the FTS
-- rebuild writes. pages itself is not rewritten; existing rows get content_hash = NULL,
-- which ingest treats as "unknown, rewrite on next revision change".
-- Keyword search returns nothing for the moment between DROP and the INSERT finishing.
--
-- Re-running: the ALTER at the end fails with "duplicate column name" once the column
-- exists. The FTS rebuild before it is idempotent, so a re-run (e.g. to repair FTS) only
-- reports that error. Statements stay in sync with FTS_ROWID_MIGRATION_STATEMENTS in
-- src/wiki/schema.ts.

DROP TABLE IF EXISTS pages_fts;

CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  search_text,
  lang UNINDEXED,
  tokenize = 'trigram case_sensitive 0'
);

INSERT INTO pages_fts (rowid, title, search_text, lang)
SELECT rowid, title, search_text, lang FROM pages;

ALTER TABLE pages ADD COLUMN content_hash TEXT;
