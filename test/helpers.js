// Shared test scaffolding. The schema is read from schema.sql itself rather
// than restated here, so a migration that is wrong in production is wrong in
// the tests too.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import worker from '../worker/index.js';
import { issueCookie } from '../worker/auth.js';

export const DAY_MS = 86400000;

// D1 executes one statement per call, and `CREATE TRIGGER ... BEGIN ... END;`
// contains semicolons that are not statement boundaries -- hence the small
// splitter rather than `sql.split(';')`.
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let inTrigger = false;

  for (const raw of sql.split('\n')) {
    const line = raw.replace(/--.*$/, '');
    if (!line.trim()) continue;
    buf += line + '\n';

    if (!inTrigger && /CREATE\s+TRIGGER/i.test(buf) && /\bBEGIN\b/i.test(buf)) inTrigger = true;

    if (inTrigger) {
      if (/^\s*END\s*;/i.test(line)) {
        out.push(buf.trim());
        buf = '';
        inTrigger = false;
      }
      continue;
    }

    if (/;\s*$/.test(line.trim())) {
      out.push(buf.trim());
      buf = '';
    }
  }

  if (buf.trim()) out.push(buf.trim());
  // D1 rejects PRAGMA; foreign keys are the database's business, not the
  // schema file's, on this runtime.
  return out.filter((s) => !/^PRAGMA\b/i.test(s));
}

export async function applySchema() {
  for (const statement of splitStatements(schemaSql)) {
    await env.DB.prepare(statement).run();
  }
}

// The pool no longer rolls storage back between tests, so every stateful test
// file starts from an empty archive by hand. Deleting through `article` fires
// the FTS delete trigger, which keeps the index in step with the table.
export async function resetDb() {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM event`),
    env.DB.prepare(`DELETE FROM article_tag`),
    env.DB.prepare(`DELETE FROM article`),
    env.DB.prepare(`DELETE FROM tag`),
    env.DB.prepare(`DELETE FROM setting`),
    env.DB.prepare(`INSERT INTO setting (key, value) VALUES ('lapse_window_days', '14')`)
  ]);
}

export function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

// Today's boundary the way the client computes it: local midnight, sent as UTC.
export function dayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function seedArticle(fields = {}) {
  const a = {
    topic_id: 1,
    url: null,
    url_normalized: null,
    title: 'A seeded article',
    source: 'example.com',
    author: null,
    published_at: null,
    body_text: null,
    summary: '',
    raw_html_key: null,
    status: 'new',
    favorite: 0,
    notes: null,
    added_at: new Date().toISOString(),
    opened_at: null,
    listened_at: null,
    resolved_at: null,
    word_count: 0,
    fetch_status: null,
    fetched_at: null,
    ...fields
  };

  const cols = Object.keys(a);
  const row = await env.DB.prepare(
    `INSERT INTO article (${cols.join(', ')})
     VALUES (${cols.map((_, i) => '?' + (i + 1)).join(', ')})
     RETURNING id`
  ).bind(...cols.map((c) => a[c])).first();

  return { ...a, id: row.id };
}

export async function countEvents(articleId, type) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM event WHERE article_id = ?1 AND type = ?2`
  ).bind(articleId, type).first();
  return row.n;
}

export async function sessionCookie() {
  const setCookie = await issueCookie(env);
  return setCookie.split(';')[0];
}

// Unit-style invocation: the router is called directly so tests can inspect
// `env` afterwards. `authed` defaults to true because every route but
// /api/session requires it.
export async function call(path, init = {}, { authed = true, cookie } = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('cookie')) {
    if (cookie !== undefined) headers.set('cookie', cookie);
    else if (authed) headers.set('cookie', await sessionCookie());
  }
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const request = new Request('https://neatinfo.test' + path, { ...init, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function callJson(path, init, opts) {
  const res = await call(path, init, opts);
  const body = await res.json().catch(() => null);
  return { res, body, status: res.status };
}
