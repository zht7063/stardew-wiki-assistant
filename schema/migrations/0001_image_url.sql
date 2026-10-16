-- Infobox portrait for pages already in D1.
-- Fresh databases get this column from schema/wiki.sql.
-- Running this twice fails with "duplicate column name", which is safe to ignore.
ALTER TABLE pages ADD COLUMN image_url TEXT;
