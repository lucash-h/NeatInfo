-- 0002 -- article_feature, for V1-33 (§8 Stage 1).
--
-- schema.sql declares this table for a database created from scratch. An
-- existing database needs it created here, run by hand, once:
--
--   npx wrangler d1 execute neatinfo --local  --file=./migrations/0002-article-feature.sql
--   npx wrangler d1 execute neatinfo --remote --file=./migrations/0002-article-feature.sql
--
-- CREATE TABLE IF NOT EXISTS is idempotent, so unlike 0001 this one is safe to
-- run twice. It is kept out of schema.sql's deploy path only for consistency:
-- migrations are where changes to existing databases live.

CREATE TABLE IF NOT EXISTS article_feature (
  article_id  INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  version     TEXT    NOT NULL,
  score       REAL    NOT NULL DEFAULT 0,
  explain     TEXT    NOT NULL DEFAULT '',
  payload     TEXT    NOT NULL DEFAULT '{}',
  computed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (article_id, version)
);

CREATE INDEX IF NOT EXISTS article_feature_version ON article_feature(version, score DESC);
