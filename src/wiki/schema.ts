/** Statements applied to local SQLite and to D1. Keep schema/wiki.sql in sync. */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS pages (
  lang TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  rev_id INTEGER NOT NULL DEFAULT 0,
  counterpart_lang TEXT,
  counterpart_title TEXT,
  counterpart_url TEXT,
  infobox_json TEXT NOT NULL DEFAULT '[]',
  sections_json TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  content_hash TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (lang, title)
)`,
  `CREATE INDEX IF NOT EXISTS pages_counterpart ON pages (counterpart_lang, counterpart_title)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  search_text,
  lang UNINDEXED,
  tokenize = 'trigram case_sensitive 0'
)`,
];

/**
 * pages_fts rows are keyed by pages.rowid, so ingest deletes and inserts one FTS row
 * by rowid instead of scanning the whole FTS table with `WHERE title = ? AND lang = ?`.
 * Databases created before this rule have unrelated FTS rowids; migration 0002
 * (schema/migrations/0002_fts_rowid_content_hash.sql, same statements) rebuilds pages_fts
 * from pages and adds pages.content_hash. The column is added last, so its presence
 * means the rebuild has run.
 */
export const FTS_ROWID_MIGRATION_STATEMENTS = [
  `DROP TABLE IF EXISTS pages_fts`,
  `CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  search_text,
  lang UNINDEXED,
  tokenize = 'trigram case_sensitive 0'
)`,
  `INSERT INTO pages_fts (rowid, title, search_text, lang)
SELECT rowid, title, search_text, lang FROM pages`,
  `ALTER TABLE pages ADD COLUMN content_hash TEXT`,
];

export const FTS_ROWID_MIGRATION_FILE = "schema/migrations/0002_fts_rowid_content_hash.sql";

export function isMissingColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column/i.test(message);
}

export const SCHEMA_SQL = `${SCHEMA_STATEMENTS.join(";\n\n")};\n`;

/** Existing databases already have `pages`. CREATE TABLE will not add columns. */
export const IMAGE_COLUMN_SQL = `ALTER TABLE pages ADD COLUMN image_url TEXT`;

export function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column/i.test(message);
}
