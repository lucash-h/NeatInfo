-- 0001 -- article.origin, for V1-28.
--
-- schema.sql declares this column for a database created from scratch. An
-- existing database needs this ALTER, and SQLite has no
-- "ADD COLUMN IF NOT EXISTS", so it is NOT in schema.sql: the deploy workflow
-- re-runs that file on every push and an unguarded ALTER would fail every
-- deploy after the first.
--
-- Run once per database, by hand:
--   npx wrangler d1 execute neatinfo --local  --file=./migrations/0001-article-origin.sql
--   npx wrangler d1 execute neatinfo --remote --file=./migrations/0001-article-origin.sql
--
-- Running it twice is an error ("duplicate column name: origin"), which is the
-- correct and harmless outcome -- it means the database already has it.

ALTER TABLE article ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS article_origin ON article(topic_id, status, origin, added_at);
