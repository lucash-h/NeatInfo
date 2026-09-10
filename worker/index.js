import { isAuthed, issueCookie, clearCookie, checkPassphrase } from './auth.js';
import { extractArticle, summarizeText, countWords, truncateBodyText } from './extract.js';
import { normalizeUrl, sourceFromUrl } from './url.js';
import { ftsQuery, buildArchiveQuery, buildArchiveCount, parseArchiveParams } from './search.js';

const TOPIC_ID = 1;

const LIST_COLUMNS = `id, url, title, source, author, published_at, summary, status,
  favorite, notes, added_at, opened_at, listened_at, resolved_at, word_count, fetch_status`;

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) }
  });

const fail = (status, message) => json({ error: message }, { status });

const nowIso = () => new Date().toISOString();

async function lapseWindow(env) {
  const row = await env.DB.prepare(`SELECT value FROM setting WHERE key = 'lapse_window_days'`).first();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

// §2.6 derives the surfaces at read time so there is no cron and no timezone
// bug. §9.4 wants lapse to be a real transition anyway, so it is written here,
// lazily, the first time a read notices an item has aged out.
async function applyLapses(env, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM article WHERE topic_id = ?1 AND status = 'new' AND added_at < ?2`
  ).bind(TOPIC_ID, cutoff).all();

  if (!results.length) return 0;

  const ts = nowIso();
  const statements = [];
  for (const { id } of results) {
    statements.push(
      env.DB.prepare(`UPDATE article SET status = 'lapsed', resolved_at = ?2 WHERE id = ?1`).bind(id, ts),
      env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, 'lapsed', ?2)`).bind(id, ts)
    );
  }
  await env.DB.batch(statements);
  return results.length;
}

function shape(row) {
  return { ...row, favorite: Boolean(row.favorite) };
}

async function withTags(env, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const { results } = await env.DB.prepare(
    `SELECT at.article_id, t.name FROM article_tag at
     JOIN tag t ON t.id = at.tag_id
     WHERE at.article_id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  const byArticle = new Map();
  for (const r of results) {
    if (!byArticle.has(r.article_id)) byArticle.set(r.article_id, []);
    byArticle.get(r.article_id).push(r.name);
  }
  return rows.map((r) => ({ ...r, tags: byArticle.get(r.id) || [] }));
}

// ---------------------------------------------------------------- surfaces

async function getFeed(env, url) {
  // The client sends its own local midnight as UTC, which is what makes
  // "Today" correct in Vancouver without the server knowing a timezone.
  const dayStart = url.searchParams.get('dayStart') || new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const filter = url.searchParams.get('filter') || 'all';
  const query = (url.searchParams.get('q') || '').trim();

  // §3 "Store" filters plus the page window. A filter the server cannot
  // honour is a 400, not a silently unfiltered archive.
  const params = parseArchiveParams(url.searchParams);
  if (params.error) return fail(400, params.error);
  const { filters, limit, offset } = params;

  const days = await lapseWindow(env);
  await applyLapses(env, days);

  const today = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM article
     WHERE topic_id = ?1 AND status = 'new' AND added_at >= ?2
     ORDER BY added_at DESC`
  ).bind(TOPIC_ID, dayStart).all();

  const pending = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM article
     WHERE topic_id = ?1 AND status = 'new' AND added_at < ?2
     ORDER BY added_at ASC`
  ).bind(TOPIC_ID, dayStart).all();

  // A search whose every character is punctuation matches nothing searchable,
  // so it falls back to the unfiltered archive instead of erroring. §3 "Store"
  const match = ftsQuery(query);
  const archiveQuery = buildArchiveQuery({
    columns: LIST_COLUMNS,
    topicId: TOPIC_ID,
    match,
    filters,
    limit,
    offset
  });
  const archive = await env.DB.prepare(archiveQuery.sql).bind(...archiveQuery.binds).all();

  // The total is counted under the same predicate as the rows, so the archive
  // can report "N of M" honestly past the end of the first page rather than
  // describing one page of 200 as the whole archive. §2.2, §3 "Store"
  const countQuery = buildArchiveCount({ topicId: TOPIC_ID, match, filters });
  const archivedTotal = await env.DB.prepare(countQuery.sql).bind(...countQuery.binds).first();

  // "Opened but undecided" is a filter on Pending, not a fourth surface. §2.3
  const pendingRows = pending.results.filter((r) => {
    if (filter === 'opened') return Boolean(r.opened_at);
    if (filter === 'unopened') return !r.opened_at;
    return true;
  });

  return json({
    lapseWindowDays: days,
    today: (await withTags(env, today.results)).map(shape),
    pending: (await withTags(env, pendingRows)).map(shape),
    pendingTotal: pending.results.length,
    archive: (await withTags(env, archive.results)).map(shape),
    archiveTotal: archivedTotal?.n ?? 0,
    archiveLimit: limit,
    archiveOffset: offset,
    archiveFilters: filters
  });
}

// ------------------------------------------------------------------ ingest

// Capture greedily at ingest, process lazily forever after. Raw HTML is the
// bulky half, so it goes to R2 and never into D1. §5.2 / §5.3
// Returns the key, or null when the copy could not be kept -- losing the raw
// copy must never lose the article.
async function captureRaw(env, html) {
  if (!env.RAW || !html) return null;

  const htmlBytes = new TextEncoder().encode(html).byteLength;
  const MAX_FILE = 2 * 1024 * 1024;    // 2 MB per file
  const BUDGET_GB = 8;                  // stop well before the 10 GB free tier
  if (htmlBytes > MAX_FILE) return null;

  try {
    const usage = await env.RAW.head('_usage');
    const stored = Number(usage?.customMetadata?.bytes || '0');
    if (stored + htmlBytes > BUDGET_GB * 1024 * 1024 * 1024) return null;
  } catch {}

  const key = `raw/${Date.now()}-${crypto.randomUUID()}.html`;
  try {
    await env.RAW.put(key, html, { httpMetadata: { contentType: 'text/html' } });
    // Update the running total (V1-19 replaces this read-modify-write).
    const prev = await env.RAW.head('_usage').catch(() => null);
    const prevBytes = Number(prev?.customMetadata?.bytes || '0');
    await env.RAW.put('_usage', '', { customMetadata: { bytes: String(prevBytes + htmlBytes) } });
    return key;
  } catch {
    return null;
  }
}

async function addArticle(env, request) {
  const payload = await request.json().catch(() => ({}));
  const rawUrl = (payload.url || '').trim();
  const pastedText = (payload.text || '').trim();

  if (!rawUrl && !pastedText) return fail(400, 'Paste a URL or some text.');

  let normalized = null;
  if (rawUrl) {
    normalized = normalizeUrl(rawUrl);
    if (!normalized) return fail(400, 'That does not look like a web address.');

    const existing = await env.DB.prepare(
      `SELECT id, title, status, resolved_at, fetch_status, body_text IS NOT NULL AS has_text
       FROM article WHERE topic_id = ?1 AND url_normalized = ?2`
    ).bind(TOPIC_ID, normalized).first();

    if (existing) {
      return json({ duplicate: true, article: shape(existing) }, { status: 409 });
    }
  }

  let record = {
    title: (payload.title || '').trim(),
    source: (payload.source || '').trim(),
    author: null,
    published_at: null,
    summary: '',
    body_text: pastedText || null,
    word_count: countWords(pastedText),
    fetch_status: pastedText ? 'pasted' : null,
    raw_html_key: null
  };

  let fetchError = null;

  if (rawUrl && !pastedText) {
    const extracted = await extractArticle(normalized);
    if (extracted.ok) {
      record = {
        title: record.title || extracted.title,
        source: record.source || extracted.source || sourceFromUrl(normalized),
        author: extracted.author,
        published_at: extracted.published_at,
        summary: extracted.summary,
        body_text: extracted.body_text,
        word_count: extracted.word_count,
        fetch_status: 'ok',
        raw_html_key: null
      };

      record.raw_html_key = await captureRaw(env, extracted.html);
    } else {
      // A failed fetch still creates the item. Never a dead end. §3 "Pull"
      fetchError = extracted.error;
      record.fetch_status = extracted.fetch_status;
      record.source = record.source || sourceFromUrl(normalized);
    }
  }

  if (!record.title) {
    record.title = pastedText
      ? pastedText.split('\n')[0].slice(0, 200).trim()
      : (normalized ? sourceFromUrl(normalized) + ' — untitled' : 'Untitled');
  }
  if (!record.source) record.source = normalized ? sourceFromUrl(normalized) : 'pasted';
  if (!record.summary) record.summary = pastedText ? summarizeText(pastedText) : '';

  // D1 rejects a value over ~1 MB outright, which would lose the article at
  // the INSERT. Cut the text instead, and recount the words so the estimated
  // read time describes what is actually here. §3 "Pull" / §5.2
  const capped = truncateBodyText(record.body_text);
  record.body_text = capped.text;
  if (capped.truncated) record.word_count = countWords(capped.text);

  const ts = nowIso();
  const inserted = await env.DB.prepare(
    `INSERT INTO article
       (topic_id, url, url_normalized, title, source, author, published_at,
        body_text, summary, raw_html_key, added_at, word_count, fetch_status, fetched_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
     RETURNING ${LIST_COLUMNS}`
  ).bind(
    TOPIC_ID, rawUrl || null, normalized, record.title, record.source, record.author,
    record.published_at, record.body_text, record.summary, record.raw_html_key,
    ts, record.word_count, record.fetch_status, ts
  ).first();

  await env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, 'added', ?2)`)
    .bind(inserted.id, ts).run();

  return json(
    { article: shape(inserted), fetchError, bodyTruncated: capped.truncated },
    { status: 201 }
  );
}

// ------------------------------------------------------------- transitions

async function resolveArticle(env, id, request) {
  const body = await request.json().catch(() => ({}));
  const status = body.status;
  if (!['kept', 'dismissed'].includes(status)) return fail(400, 'Unknown resolution.');

  const favorite = status === 'kept' && Boolean(body.favorite);
  const ts = nowIso();

  const row = await env.DB.prepare(
    `UPDATE article SET status = ?2, favorite = ?3, resolved_at = ?4
     WHERE id = ?1 AND topic_id = ?5
     RETURNING ${LIST_COLUMNS}`
  ).bind(id, status, favorite ? 1 : 0, ts, TOPIC_ID).first();

  if (!row) return fail(404, 'No such article.');

  const statements = [
    env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, ?2, ?3)`)
      .bind(id, status, ts)
  ];
  if (favorite) {
    statements.push(
      env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, 'starred', ?2)`).bind(id, ts)
    );
  }
  await env.DB.batch(statements);

  return json({ article: shape(row) });
}

async function markTimestamp(env, id, column, eventType) {
  const ts = nowIso();
  const row = await env.DB.prepare(
    `UPDATE article SET ${column} = COALESCE(${column}, ?2) WHERE id = ?1 AND topic_id = ?3
     RETURNING ${LIST_COLUMNS}`
  ).bind(id, ts, TOPIC_ID).first();

  if (!row) return fail(404, 'No such article.');

  await env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, ?2, ?3)`)
    .bind(id, eventType, ts).run();

  return json({ article: shape(row) });
}

async function setStar(env, id, request) {
  const body = await request.json().catch(() => ({}));
  const favorite = Boolean(body.favorite);
  const row = await env.DB.prepare(
    `UPDATE article SET favorite = ?2 WHERE id = ?1 AND topic_id = ?3 RETURNING ${LIST_COLUMNS}`
  ).bind(id, favorite ? 1 : 0, TOPIC_ID).first();

  if (!row) return fail(404, 'No such article.');

  await env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, ?2, ?3)`)
    .bind(id, favorite ? 'starred' : 'unstarred', nowIso()).run();

  return json({ article: shape(row) });
}

// §3 "Pull" promises the app is never a dead end. That has to hold *after*
// ingest too: a failed fetch leaves a row with a URL and no text, and the only
// way to rescue it is to supply the title, source and body here.
async function updateArticle(env, id, request) {
  const body = await request.json().catch(() => ({}));
  const statements = [];

  const sets = [];
  const binds = [];

  if (typeof body.notes === 'string') {
    sets.push('notes = ?');
    binds.push(body.notes);
  }
  if (typeof body.title === 'string' && body.title.trim()) {
    sets.push('title = ?');
    binds.push(body.title.trim().slice(0, 300));
  }
  if (typeof body.source === 'string' && body.source.trim()) {
    sets.push('source = ?');
    binds.push(body.source.trim().slice(0, 200));
  }
  let bodyTruncated = false;
  if (typeof body.body_text === 'string' && body.body_text.trim()) {
    // Same cap as ingest: a paste out of a very long page must not 500. §5.2
    const capped = truncateBodyText(body.body_text.trim());
    const text = capped.text;
    bodyTruncated = capped.truncated;
    sets.push('body_text = ?', 'word_count = ?', "fetch_status = 'pasted'", 'fetched_at = ?');
    binds.push(text, countWords(text), nowIso());
    // A summary already on the card is not replaced behind the reader's back;
    // an empty one is filled from the pasted text. §3 "Show"
    sets.push("summary = CASE WHEN summary IS NULL OR summary = '' THEN ? ELSE summary END");
    binds.push(summarizeText(text));
  }

  if (sets.length) {
    statements.push(
      env.DB.prepare(`UPDATE article SET ${sets.join(', ')} WHERE id = ? AND topic_id = ?`)
        .bind(...binds, id, TOPIC_ID)
    );
  }

  if (Array.isArray(body.tags)) {
    const names = [...new Set(body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    statements.push(env.DB.prepare(`DELETE FROM article_tag WHERE article_id = ?1`).bind(id));
    for (const name of names) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO tag (name) VALUES (?1)`).bind(name));
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO article_tag (article_id, tag_id)
           VALUES (?1, (SELECT id FROM tag WHERE name = ?2))`
        ).bind(id, name)
      );
    }
  }

  if (statements.length) await env.DB.batch(statements);

  const row = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS}, body_text FROM article WHERE id = ?1 AND topic_id = ?2`
  ).bind(id, TOPIC_ID).first();
  if (!row) return fail(404, 'No such article.');

  const [withTag] = await withTags(env, [row]);
  return json({ article: shape(withTag), bodyTruncated });
}

// The other half of "never a dead end": a fetch that failed for a transient
// reason (a 503, a timeout) is retryable in place, without deleting the item
// and tripping the duplicate guard on the way back in. §3 "Pull"
async function refetchArticle(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, url_normalized, title, source FROM article WHERE id = ?1 AND topic_id = ?2`
  ).bind(id, TOPIC_ID).first();
  if (!row) return fail(404, 'No such article.');
  if (!row.url_normalized) return fail(400, 'That item has no URL to fetch.');

  const extracted = await extractArticle(row.url_normalized);
  const ts = nowIso();

  if (!extracted.ok) {
    await env.DB.prepare(`UPDATE article SET fetch_status = ?2, fetched_at = ?3 WHERE id = ?1`)
      .bind(id, extracted.fetch_status, ts).run();
    const failed = await env.DB.prepare(
      `SELECT ${LIST_COLUMNS}, body_text FROM article WHERE id = ?1`
    ).bind(id).first();
    return json({ article: shape(failed), fetchError: extracted.error });
  }

  const rawKey = await captureRaw(env, extracted.html);
  const capped = truncateBodyText(extracted.body_text);
  const updated = await env.DB.prepare(
    `UPDATE article SET
       title = ?2, source = ?3, author = COALESCE(?4, author), published_at = COALESCE(?5, published_at),
       body_text = ?6, summary = ?7, word_count = ?8,
       raw_html_key = COALESCE(?9, raw_html_key),
       fetch_status = 'ok', fetched_at = ?10
     WHERE id = ?1 AND topic_id = ?11
     RETURNING ${LIST_COLUMNS}, body_text`
  ).bind(
    id,
    extracted.title || row.title,
    extracted.source || row.source,
    extracted.author,
    extracted.published_at,
    capped.text,
    extracted.summary,
    capped.truncated ? countWords(capped.text) : extracted.word_count,
    rawKey,
    ts,
    TOPIC_ID
  ).first();

  return json({ article: shape(updated), fetchError: null, bodyTruncated: capped.truncated });
}

async function getArticle(env, id) {
  const row = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS}, body_text FROM article WHERE id = ?1 AND topic_id = ?2`
  ).bind(id, TOPIC_ID).first();
  if (!row) return fail(404, 'No such article.');
  const [withTag] = await withTags(env, [row]);
  return json({ article: shape(withTag) });
}

// -------------------------------------------------------- settings, export

async function settings(env, request) {
  if (request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const n = Number(body.lapseWindowDays);
    if (!Number.isFinite(n) || n < 1 || n > 365) return fail(400, 'Lapse window must be 1-365 days.');
    await env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES ('lapse_window_days', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(String(Math.round(n))).run();
  }
  let r2UsageMb = null;
  if (env.RAW) {
    try {
      const meta = await env.RAW.head('_usage');
      r2UsageMb = Math.round(Number(meta?.customMetadata?.bytes || '0') / 1024 / 1024);
    } catch {}
  }
  return json({ lapseWindowDays: await lapseWindow(env), r2UsageMb, r2BudgetMb: 8 * 1024 });
}

// Losing the archive deletes the project's entire value, so export ships in
// v1 rather than as a stretch goal. §3 "Store"
async function exportAll(env) {
  const articles = await env.DB.prepare(`SELECT * FROM article WHERE topic_id = ?1 ORDER BY id`).bind(TOPIC_ID).all();
  const events = await env.DB.prepare(`SELECT * FROM event ORDER BY id`).all();
  const tags = await env.DB.prepare(
    `SELECT at.article_id, t.name FROM article_tag at JOIN tag t ON t.id = at.tag_id`
  ).all();

  const body = JSON.stringify(
    {
      exported_at: nowIso(),
      schema_version: 1,
      articles: articles.results,
      events: events.results,
      article_tags: tags.results
    },
    null,
    2
  );

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="neatinfo-${nowIso().slice(0, 10)}.json"`
    }
  });
}

// ------------------------------------------------------------------ router

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (path === '/api/session') {
      if (request.method === 'GET') return json({ authed: await isAuthed(request, env) });
      if (request.method === 'DELETE') return json({ authed: false }, { headers: { 'set-cookie': clearCookie() } });
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!checkPassphrase(env, body.passphrase)) return fail(401, 'Wrong passphrase.');
        return json({ authed: true }, { headers: { 'set-cookie': await issueCookie(env) } });
      }
      return fail(405, 'Method not allowed.');
    }

    if (!(await isAuthed(request, env))) return fail(401, 'Not signed in.');

    try {
      if (path === '/api/feed' && request.method === 'GET') return await getFeed(env, url);
      if (path === '/api/articles' && request.method === 'POST') return await addArticle(env, request);
      if (path === '/api/settings') return await settings(env, request);
      if (path === '/api/export' && request.method === 'GET') return await exportAll(env);

      const match = path.match(/^\/api\/articles\/(\d+)(?:\/(open|listen|resolve|star|refetch))?$/);
      if (match) {
        const id = Number(match[1]);
        const action = match[2];
        if (!action && request.method === 'GET') return await getArticle(env, id);
        if (!action && request.method === 'PATCH') return await updateArticle(env, id, request);
        if (action === 'open' && request.method === 'POST') return await markTimestamp(env, id, 'opened_at', 'opened');
        if (action === 'listen' && request.method === 'POST') return await markTimestamp(env, id, 'listened_at', 'listened');
        if (action === 'resolve' && request.method === 'POST') return await resolveArticle(env, id, request);
        if (action === 'star' && request.method === 'POST') return await setStar(env, id, request);
        if (action === 'refetch' && request.method === 'POST') return await refetchArticle(env, id);
        return fail(405, 'Method not allowed.');
      }

      return fail(404, 'No such endpoint.');
    } catch (err) {
      return fail(500, String((err && err.message) || err));
    }
  }
};
