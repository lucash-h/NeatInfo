// Turns an /api/export payload back into the statements that reproduce the
// database, row for row. V1-24 -- "export round-trip and completeness."
//
// Deliberately pure and side-effect-free: it builds `{ sql, binds }` objects,
// it does not execute them. That lets one codepath serve both the test (which
// runs the statements against env.DB in workerd) and scripts/import.mjs
// (which renders the same statements as literal SQL text for `wrangler d1
// execute --file=`). No `node:` import belongs here -- this file is loaded
// inside workerd by the test suite, which has no filesystem or process.
//
// schema_version is read but not branched on yet: v1 has shipped only one
// version, so there is nothing to migrate between. A future bump should add
// a switch here rather than assume the shapes below are the only ones.

const ARTICLE_COLUMNS = [
  'id', 'topic_id', 'url', 'url_normalized', 'title', 'source', 'author',
  'published_at', 'body_text', 'summary', 'raw_html_key', 'status',
  'favorite', 'notes', 'added_at', 'opened_at', 'listened_at', 'resolved_at',
  'word_count', 'fetch_status', 'fetched_at'
];

const EVENT_COLUMNS = ['id', 'article_id', 'type', 'created_at'];

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// A .sql file has no bind parameters, so each statement's `?N` placeholders
// are inlined as escaped literals in order. The whitespace collapse must run
// on the SQL *template* before literals are inlined, not on the rendered
// result -- collapsing after inlining flattens whitespace inside the literals
// themselves (a multi-line body_text, a tab, a run of spaces), which is
// silent data corruption in exactly the path this tool exists to make
// trustworthy. `wrangler d1 execute --file=` parses SQL properly, so a
// literal spanning multiple lines in the output file is fine as-is.
export function renderStatement({ sql, binds }) {
  const template = sql.trim().replace(/\s+/g, ' ');
  let i = 0;
  return template.replace(/\?\d+/g, () => sqlLiteral(binds[i++])) + ';';
}

export function buildImportStatements(payload) {
  const statements = [];
  const p = payload || {};

  // Topics and settings first: articles carry a topic_id FK, and topic/setting
  // rows are seeded by schema.sql, so both are upserts rather than inserts.
  for (const t of p.topics || []) {
    statements.push({
      sql: `INSERT INTO topic (id, name, active, created_at) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = excluded.active, created_at = excluded.created_at`,
      binds: [t.id, t.name, t.active, t.created_at]
    });
  }

  for (const s of p.settings || []) {
    statements.push({
      sql: `INSERT INTO setting (key, value) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      binds: [s.key, s.value]
    });
  }

  // Explicit `id` in the column list: article_tag and event.article_id below
  // reattach by the original id, so it must survive the round trip rather
  // than being reassigned by AUTOINCREMENT. Inserting here also fires the
  // article_ai FTS trigger (schema.sql), which is wanted -- the restored
  // archive must be searchable, not just present.
  for (const a of p.articles || []) {
    statements.push({
      sql: `INSERT INTO article (${ARTICLE_COLUMNS.join(', ')})
            VALUES (${ARTICLE_COLUMNS.map((_, i) => '?' + (i + 1)).join(', ')})`,
      binds: ARTICLE_COLUMNS.map((c) => (a[c] === undefined ? null : a[c]))
    });
  }

  for (const e of p.events || []) {
    statements.push({
      sql: `INSERT INTO event (${EVENT_COLUMNS.join(', ')})
            VALUES (${EVENT_COLUMNS.map((_, i) => '?' + (i + 1)).join(', ')})`,
      binds: EVENT_COLUMNS.map((c) => (e[c] === undefined ? null : e[c]))
    });
  }

  // article_tags are exported by tag *name* (updateArticle does the same),
  // so tags are recreated first and article_tag resolves the name to
  // whatever id it lands on this time -- the same shape updateArticle uses.
  const tagPairs = p.article_tags || [];
  const names = [...new Set(tagPairs.map((row) => row.name))];
  for (const name of names) {
    statements.push({
      sql: `INSERT OR IGNORE INTO tag (name) VALUES (?1)`,
      binds: [name]
    });
  }
  for (const row of tagPairs) {
    statements.push({
      sql: `INSERT OR IGNORE INTO article_tag (article_id, tag_id)
            VALUES (?1, (SELECT id FROM tag WHERE name = ?2))`,
      binds: [row.article_id, row.name]
    });
  }

  // raw_html_keys is a manifest of what the export expects in R2, not rows in
  // D1 -- nothing to insert for it here. A restore script reads it to know
  // which raw captures are missing, separately from this statement list.

  return statements;
}
