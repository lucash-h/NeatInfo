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
CREATE INDEX IF NOT EXISTS article_resolved ON article(topic_id, status, resolved_at);

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

INSERT OR IGNORE INTO topic (id, name, active) VALUES (1, 'AI', 1);
INSERT OR IGNORE INTO setting (key, value) VALUES ('lapse_window_days', '14');
