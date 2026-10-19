CREATE TABLE IF NOT EXISTS pages (
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
);

CREATE INDEX IF NOT EXISTS pages_counterpart ON pages (counterpart_lang, counterpart_title);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  search_text,
  lang UNINDEXED,
  tokenize = 'trigram case_sensitive 0'
);
