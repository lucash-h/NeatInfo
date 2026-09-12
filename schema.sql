-- NeatInfo v1 schema (D1 / SQLite)
-- Mirrors NeatInfo_Design_Report.md §4.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topic (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id       INTEGER NOT NULL REFERENCES topic(id),

  url            TEXT,
  url_normalized TEXT,

  title          TEXT NOT NULL,
  source         TEXT NOT NULL,
  author         TEXT,
  published_at   TEXT,

  body_text      TEXT,
  summary        TEXT NOT NULL DEFAULT '',
  raw_html_key   TEXT,             -- R2 object key; body stays out of D1

  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','kept','dismissed','lapsed')),

  -- Who put it here. Today is what you chose today; anything a machine
  -- found waits in Pending instead, however recently it arrived, so the
  -- daily page cannot be flooded by a poll. §7.7
  origin         TEXT NOT NULL DEFAULT 'manual'
                 CHECK (origin IN ('manual','auto')),
  favorite       INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,

  added_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  opened_at      TEXT,
  listened_at    TEXT,
  resolved_at    TEXT,

  word_count     INTEGER NOT NULL DEFAULT 0,
  fetch_status   TEXT,             -- 'ok' | 'failed' | 'pasted' | http status
  fetched_at     TEXT
);

-- Duplicate detection is per topic, and only for items that have a URL.
CREATE UNIQUE INDEX IF NOT EXISTS article_url_unique
  ON article(topic_id, url_normalized) WHERE url_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS article_surface ON article(topic_id, status, added_at);

-- Today filters on origin as well as status and date, so the surface index
-- gets it too; Pending is the complement and uses the same index.
CREATE INDEX IF NOT EXISTS article_origin ON article(topic_id, status, origin, added_at);
CREATE INDEX IF NOT EXISTS article_resolved ON article(topic_id, status, resolved_at);

-- The archive filter bar filters and facets by source, so both the WHERE and
-- the GROUP BY behind /api/facets have an index to walk. §3 "Store"
CREATE INDEX IF NOT EXISTS article_source ON article(topic_id, source);

-- The date-range filter is on added_at across every status, which the
-- status-prefixed indexes above cannot serve.
CREATE INDEX IF NOT EXISTS article_added ON article(topic_id, added_at);

-- Starred is a surface of its own and is a favorite=1 filter server-side, so
-- the index is partial: it holds only the rows that surface can show.
CREATE INDEX IF NOT EXISTS article_favorite ON article(topic_id, resolved_at) WHERE favorite = 1;

CREATE TABLE IF NOT EXISTS tag (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS article_tag (
  article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

-- Not read by v1. Written from day one because v2 cannot reconstruct it. §4
CREATE TABLE IF NOT EXISTS event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  type       TEXT NOT NULL
             CHECK (type IN ('added','opened','kept','starred','dismissed','lapsed','listened','unstarred')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS event_article ON event(article_id, created_at);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- FTS5 over the searchable columns. §3 "Store"
CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(
  title, summary, body_text, notes, source,
  content = 'article',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS article_ai AFTER INSERT ON article BEGIN
  INSERT INTO article_fts(rowid, title, summary, body_text, notes, source)
  VALUES (new.id, new.title, new.summary, new.body_text, new.notes, new.source);
END;

CREATE TRIGGER IF NOT EXISTS article_ad AFTER DELETE ON article BEGIN
  INSERT INTO article_fts(article_fts, rowid, title, summary, body_text, notes, source)
  VALUES ('delete', old.id, old.title, old.summary, old.body_text, old.notes, old.source);
END;

CREATE TRIGGER IF NOT EXISTS article_au AFTER UPDATE ON article BEGIN
  INSERT INTO article_fts(article_fts, rowid, title, summary, body_text, notes, source)
  VALUES ('delete', old.id, old.title, old.summary, old.body_text, old.notes, old.source);
  INSERT INTO article_fts(rowid, title, summary, body_text, notes, source)
  VALUES (new.id, new.title, new.summary, new.body_text, new.notes, new.source);
END;

-- ---------------------------------------------------------------- discovery

CREATE TABLE IF NOT EXISTS feed_source (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  url             TEXT    NOT NULL UNIQUE,
  tier            INTEGER NOT NULL DEFAULT 2
                  CHECK (tier IN (1, 2, 3)),
  format          TEXT    NOT NULL DEFAULT 'rss'
                  CHECK (format IN ('rss','atom','json','api')),
  active          INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT,
  weight_modifier REAL    NOT NULL DEFAULT 1.0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidate (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        TEXT    NOT NULL,
  feed_source_id  INTEGER REFERENCES feed_source(id),
  url             TEXT    NOT NULL,
  url_normalized  TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  summary         TEXT    NOT NULL DEFAULT '',
  source          TEXT    NOT NULL DEFAULT '',
  author          TEXT,
  published_at    TEXT,
  score           REAL    NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','kept','skipped')),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_url_unique
  ON candidate(url_normalized) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS candidate_batch
  ON candidate(batch_id, status, score DESC);

-- -------------------------------------------------------------------- seeds

INSERT OR IGNORE INTO topic (id, name, active) VALUES (1, 'AI', 1);
INSERT OR IGNORE INTO setting (key, value) VALUES ('lapse_window_days', '14');

-- Tier 1: Lab blogs (primary announcements)
INSERT OR IGNORE INTO feed_source (name, url, tier, format) VALUES
  ('OpenAI Blog',       'https://openai.com/blog/rss.xml',                          1, 'rss'),
  ('Anthropic Blog',    'https://www.anthropic.com/rss.xml',                         1, 'rss'),
  ('Google DeepMind',   'https://deepmind.google/blog/rss.xml',                      1, 'rss'),
  ('Meta AI Blog',      'https://ai.meta.com/blog/rss/',                             1, 'rss');

-- Tier 2: Editorial (analysis, context)
INSERT OR IGNORE INTO feed_source (name, url, tier, format) VALUES
  ('TechCrunch AI',     'https://techcrunch.com/category/artificial-intelligence/feed/', 2, 'rss'),
  ('The Verge AI',      'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 2, 'rss'),
  ('MIT Tech Review AI','https://www.technologyreview.com/topic/artificial-intelligence/feed/', 2, 'rss'),
  ('Ars Technica AI',   'https://feeds.arstechnica.com/arstechnica/technology-lab',  2, 'rss');

-- Tier 3: Community / research
INSERT OR IGNORE INTO feed_source (name, url, tier, format) VALUES
  ('Hacker News',       'https://hn.algolia.com/api/v1/search',                     3, 'api'),
  ('arXiv cs.AI',       'https://rss.arxiv.org/rss/cs.AI',                          3, 'rss');
