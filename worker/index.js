import { isAuthed, issueCookie, clearCookie, checkPassphrase } from './auth.js';
import { extractArticle, summarizeText, countWords, truncateBodyText, decodeEntities } from './extract.js';
import { normalizeUrl, sourceFromUrl } from './url.js';
import { ftsQuery, buildArchiveQuery, buildArchiveCount, parseArchiveParams } from './search.js';
import { segmentText, speechText, generateSegment, MAX_SEGMENTS } from './speech.js';

const TOPIC_ID = 1;

const LIST_COLUMNS = `id, url, title, source, author, published_at, summary, status,
  favorite, notes, added_at, opened_at, listened_at, resolved_at, word_count, fetch_status,
  origin`;

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

// Rows per lapse batch. Each row contributes two statements, so this is 100
// statements a batch -- the same order as the 100 bound-variable ceiling that
// broke the 200-row archive page in V1-18.
const LAPSE_CHUNK = 50;

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
  // Two statements per lapsed row, and the row set is however many items aged
  // out since the last read. At five a day that is a handful; after a month
  // away it is a few hundred, and after a restore of an old archive it is the
  // whole table in one batch. Nothing in D1 promises to accept a batch of
  // arbitrary size, so it is chunked and the loop carries the rest. §9.4
  for (let i = 0; i < results.length; i += LAPSE_CHUNK) {
    const statements = [];
    for (const { id } of results.slice(i, i + LAPSE_CHUNK)) {
      statements.push(
        env.DB.prepare(`UPDATE article SET status = 'lapsed', resolved_at = ?2 WHERE id = ?1`).bind(id, ts),
        env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, 'lapsed', ?2)`).bind(id, ts)
      );
    }
    await env.DB.batch(statements);
  }
  return results.length;
}

function shape(row) {
  return { ...row, favorite: Boolean(row.favorite) };
}

// D1 refuses a statement with more than 100 bound variables, so a full page of
// archive rows cannot be looked up in one `IN (...)`. Found by the 250-row
// paging test: a 200-row page came back as a 500. §3 "Store"
const BIND_CHUNK = 90;

async function withTags(env, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);

  const byArticle = new Map();
  for (let i = 0; i < ids.length; i += BIND_CHUNK) {
    const chunk = ids.slice(i, i + BIND_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT at.article_id, t.name FROM article_tag at
       JOIN tag t ON t.id = at.tag_id
       WHERE at.article_id IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all();

    for (const r of results) {
      if (!byArticle.has(r.article_id)) byArticle.set(r.article_id, []);
      byArticle.get(r.article_id).push(r.name);
    }
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

  // Today is what *you* chose today. A poll that found forty things must not
  // be able to flood the one page whose whole value is that it is short, so
  // anything a machine added waits in Pending however recently it arrived --
  // and Pending is exactly the complement, so nothing can fall between them.
  // §7.7, §2.6
  const today = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM article
     WHERE topic_id = ?1 AND status = 'new' AND added_at >= ?2 AND origin = 'manual'
     ORDER BY added_at DESC`
  ).bind(TOPIC_ID, dayStart).all();

  const pending = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM article
     WHERE topic_id = ?1 AND status = 'new' AND (added_at < ?2 OR origin = 'auto')
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

// The filter bar needs to know what there is to filter by. Deriving that on
// the client from one page of rows would offer only the sources and tags that
// happened to be on that page -- the same partial-page lie paging exists to
// end -- so it is one indexed round trip over the whole archive instead.
// §3 "Store"
async function getFacets(env) {
  const [sources, tags, floor] = await env.DB.batch([
    env.DB.prepare(
      `SELECT source AS name, COUNT(*) AS count FROM article
       WHERE topic_id = ?1 AND status != 'new'
       GROUP BY source ORDER BY count DESC, source ASC`
    ).bind(TOPIC_ID),
    env.DB.prepare(
      `SELECT t.name AS name, COUNT(*) AS count
       FROM article_tag at
       JOIN tag t ON t.id = at.tag_id
       JOIN article a ON a.id = at.article_id
       WHERE a.topic_id = ?1 AND a.status != 'new'
       GROUP BY t.name ORDER BY count DESC, t.name ASC`
    ).bind(TOPIC_ID),
    env.DB.prepare(
      `SELECT MIN(added_at) AS earliest FROM article WHERE topic_id = ?1 AND status != 'new'`
    ).bind(TOPIC_ID)
  ]);

  return json({
    sources: sources.results,
    tags: tags.results,
    // The floor for the date inputs: there is nothing to find before it.
    earliestAddedAt: floor.results[0]?.earliest ?? null
  });
}

// ------------------------------------------------------------------ ingest

// Capture greedily at ingest, process lazily forever after. Raw HTML is the
// bulky half, so it goes to R2 and never into D1. §5.2 / §5.3

const RAW_MAX_FILE = 2 * 1024 * 1024;               // 2 MB per object
const RAW_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;    // stop well before the 10 GB free tier
const RAW_USAGE_KEY = 'r2_usage_bytes';
const RAW_USAGE_AT = 'r2_usage_at';

// How many bytes R2 is holding, as last measured. The number lives in D1
// rather than in an R2 object because D1 is a single writer and
// `value = value + n` is one atomic statement: the old counter was an R2
// read-modify-write (`head`, then `put`), so two adds landing together lost
// one of the two counts, and a deleted object never subtracted. §5.2
async function cachedRawUsage(env) {
  const row = await env.DB.prepare(`SELECT value FROM setting WHERE key = ?1`)
    .bind(RAW_USAGE_KEY).first();
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function bumpRawUsage(env, delta) {
  await env.DB.prepare(
    `INSERT INTO setting (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(setting.value AS INTEGER) + ?3 AS TEXT)`
  ).bind(RAW_USAGE_KEY, String(delta), delta).run();
}

// The authoritative figure: page the bucket and add the sizes up. This is the
// only thing that can see a deletion, so it is what /api/settings reports and
// what the cache is refreshed from. It costs one list call per 1,000 objects,
// which is why the ingest path reads the cache instead.
async function measureRawUsage(env) {
  if (!env.RAW) return null;
  let bytes = 0;
  let cursor;
  do {
    const page = await env.RAW.list({ limit: 1000, cursor });
    for (const object of page.objects) bytes += object.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(RAW_USAGE_KEY, String(bytes)),
    env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(RAW_USAGE_AT, nowIso())
  ]);

  return bytes;
}

// Returns the key, or null when the copy could not be kept -- losing the raw
// copy must never lose the article.
//
// The R2 cost of an add is exactly one operation: the `put`. The budget check
// is a D1 read, and the counter update is a D1 write.
async function captureRaw(env, html) {
  if (!env.RAW || !html) return null;

  const htmlBytes = new TextEncoder().encode(html).byteLength;
  if (htmlBytes > RAW_MAX_FILE) return null;

  let stored = await cachedRawUsage(env);
  if (stored === null) {
    // First capture after a deploy or a reset: measure once, then the cache
    // carries it. A measurement that fails must not block the capture -- the
    // put below will fail too if R2 is really down.
    stored = await measureRawUsage(env).catch(() => null);
  }
  if (stored !== null && stored + htmlBytes > RAW_BUDGET_BYTES) {
    // Only at the ceiling is the exact number worth paying for: the cache can
    // only ever over-count (deletions), and a stale over-count must not refuse
    // a capture that would actually fit.
    const exact = await measureRawUsage(env).catch(() => null);
    if (exact !== null && exact + htmlBytes > RAW_BUDGET_BYTES) return null;
  }

  const key = `raw/${Date.now()}-${crypto.randomUUID()}.html`;
  try {
    await env.RAW.put(key, html, { httpMetadata: { contentType: 'text/html' } });
  } catch {
    return null;
  }
  // Outside the try: a counter that failed to move is a stale number, not a
  // lost article, and /api/settings re-measures anyway.
  await bumpRawUsage(env, htmlBytes).catch(() => {});
  return key;
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

  // A poller says origin:'auto' (it waits in Pending, never Today) and
  // defer:true (insert the row now, fetch the page later). Deferring is what
  // keeps a scheduled run inside the free plan's 10ms CPU and 50-subrequest
  // ceiling: discovering forty links costs one subrequest per *source*, not
  // one per article, and extraction happens on the refetch path when you
  // actually open something. §7.4
  const origin = payload.origin === 'auto' ? 'auto' : 'manual';
  const defer = Boolean(payload.defer);

  // Decoded at the boundary, for the same reason Meta.element decodes: this is
  // where untrusted text enters. It matters more here than it looks -- RSS is
  // XML, so `&amp;` is mandatory and `&#8217;` ubiquitous, and discover/ has no
  // decoding of its own by design (it must stay dependency-free). A caller's
  // title also *outranks* the extractor's below, so an undecoded one would win
  // over the clean one extraction just produced. V1-30
  let record = {
    title: decodeEntities((payload.title || '').trim()),
    source: decodeEntities((payload.source || '').trim()),
    author: null,
    published_at: null,
    summary: '',
    body_text: pastedText || null,
    word_count: countWords(pastedText),
    fetch_status: pastedText ? 'pasted' : null,
    raw_html_key: null
  };

  let fetchError = null;

  if (rawUrl && !pastedText && !defer) {
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
        body_text, summary, raw_html_key, added_at, word_count, fetch_status, fetched_at,
        origin)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
     RETURNING ${LIST_COLUMNS}`
  ).bind(
    TOPIC_ID, rawUrl || null, normalized, record.title, record.source, record.author,
    record.published_at, record.body_text, record.summary, record.raw_html_key,
    ts, record.word_count, record.fetch_status, defer ? null : ts,
    origin
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
  // Author had no route in at all, which left refetch as the only way to
  // repair one -- and refetch cannot reach a page that now 403s. V1-30
  if (typeof body.author === 'string' && body.author.trim()) {
    sets.push('author = ?');
    binds.push(body.author.trim().slice(0, 300));
  }

  // D8 (V1-30). An explicit summary is the caller stating exactly what it
  // wants -- a repair pass, or an edit -- and it overwrites. That is a
  // different act from the derived summary below, which fills an empty field
  // as a side effect of pasting text and must never overwrite something you
  // have already read. Both behaviours are wanted; they are just not the same
  // request.
  // Empty is ignored, matching title and source. Blanking a summary is not
  // something any current caller wants, and an edit form PATCHing {title,
  // summary} with the box left empty would otherwise destroy it silently.
  const explicitSummary =
    typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim() : null;
  if (explicitSummary !== null) {
    sets.push('summary = ?');
    binds.push(explicitSummary.slice(0, 2000));
  }

  let bodyTruncated = false;
  if (typeof body.body_text === 'string' && body.body_text.trim()) {
    // Same cap as ingest: a paste out of a very long page must not 500. §5.2
    const capped = truncateBodyText(body.body_text.trim());
    const text = capped.text;
    bodyTruncated = capped.truncated;
    // `keep_fetch_status` is for a repair: decoding entities in stored text is
    // a pure local transform, and relabelling two dozen fetched articles as
    // hand-pasted would destroy the one signal that says where text came from.
    // Explicit rather than inferred -- a clever "is this the same text modulo
    // decoding?" check is how you end up with another comment that is
    // confidently wrong about what the code does. V1-30
    if (body.keep_fetch_status === true) {
      sets.push('body_text = ?', 'word_count = ?');
      binds.push(text, countWords(text));
    } else {
      sets.push('body_text = ?', 'word_count = ?', "fetch_status = 'pasted'", 'fetched_at = ?');
      binds.push(text, countWords(text), nowIso());
    }
    // A summary already on the card is not replaced behind the reader's back;
    // an empty one is filled from the pasted text. §3 "Show"
    //
    // Skipped entirely when the caller named a summary: assigning the same
    // column twice in one UPDATE is ambiguous at best, and the explicit value
    // is the one that was asked for.
    if (explicitSummary === null) {
      sets.push("summary = CASE WHEN summary IS NULL OR summary = '' THEN ? ELSE summary END");
      binds.push(summarizeText(text));
    }
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

// §5.4 asks for a ten-minute check that the raw capture has the *shape* v2
// needs -- outbound links, numeric density, chunkable text. That check cannot
// be run at all while the only copy of the raw HTML is an R2 key nothing
// serves, so this streams the object straight through rather than buffering a
// 2 MB page into memory to hand it back. §5.2 / §5.4
async function getRawHtml(env, id) {
  const row = await env.DB.prepare(
    `SELECT raw_html_key FROM article WHERE id = ?1 AND topic_id = ?2`
  ).bind(id, TOPIC_ID).first();

  if (!row) return fail(404, 'No such article.');
  // A pasted item, a failed fetch, a page over the per-object cap: all of them
  // are articles with no raw copy, which is a 404 for this resource rather
  // than an error about the article.
  if (!row.raw_html_key) return fail(404, 'No raw copy was kept for that one.');
  if (!env.RAW) return fail(404, 'Raw capture is not configured.');

  const object = await env.RAW.get(row.raw_html_key).catch(() => null);
  if (!object) return fail(404, 'The raw copy is no longer in R2.');

  return new Response(object.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(object.size),
      etag: object.httpEtag,
      // Raw HTML is a snapshot: once written it never changes.
      'cache-control': 'private, max-age=31536000, immutable'
    }
  });
}

// Tier 2 speech. §6 / V1-32
//
// Two routes: a manifest saying how many segments there are, and the audio for
// one segment. Nothing is cached -- see worker/speech.js for why -- so this is
// generated on the way to the reader and exists nowhere afterwards.

// A day's ceiling on generation. MAX_SEGMENTS bounds one article; nothing
// bounded a day, and the per-article figure is not what runs the allowance
// down -- retrying a failed article from segment zero is. Free tier is 10,000
// neurons/day and a segment is roughly 14, so 400 leaves comfortable room and
// still covers far more listening than a day holds.
//
// Same shape as r2_usage_bytes: a `setting` row, incremented with one atomic
// statement, because D1 is a single writer and a read-modify-write here would
// lose counts exactly when the day is busiest. §5.2
const AUDIO_DAY_LIMIT = 400;
const AUDIO_DAY_KEY = 'audio_segments_day';
const AUDIO_DAY_DATE = 'audio_segments_date';

async function audioDayCount(env) {
  const today = nowIso().slice(0, 10);
  const rows = await env.DB.prepare(
    `SELECT key, value FROM setting WHERE key IN (?1, ?2)`
  ).bind(AUDIO_DAY_KEY, AUDIO_DAY_DATE).all();

  const map = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  // A stale date means the count belongs to a day that is over.
  if (map[AUDIO_DAY_DATE] !== today) return { used: 0, today };
  const n = Number(map[AUDIO_DAY_KEY]);
  return { used: Number.isFinite(n) && n > 0 ? n : 0, today };
}

async function bumpAudioDay(env, today) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(AUDIO_DAY_DATE, today),
    env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES (?1, '1')
       ON CONFLICT(key) DO UPDATE SET value =
         CAST(CASE WHEN (SELECT value FROM setting WHERE key = ?2) = ?3
                   THEN CAST(setting.value AS INTEGER) + 1 ELSE 1 END AS TEXT)`
    ).bind(AUDIO_DAY_KEY, AUDIO_DAY_DATE, today)
  ]);
}

async function getAudioManifest(env, id) {
  const row = await env.DB.prepare(
    `SELECT title, source, body_text FROM article WHERE id = ?1 AND topic_id = ?2`
  ).bind(id, TOPIC_ID).first();
  if (!row) return fail(404, 'No such article.');

  if (!env.AI) {
    // Not an error: the browser voice is the floor, and the client asks this
    // question precisely so it can fall back without a failed request.
    return json({ available: false, reason: 'Workers AI is not configured.', segments: 0 });
  }

  const segments = segmentText(speechText(row));
  if (!segments.length) return json({ available: false, reason: 'Nothing to read aloud.', segments: 0 });

  // A ceiling per article, so one very long paper cannot quietly spend the
  // day's neurons. Truncating would be worse than refusing: it would read
  // three quarters of something and stop without saying why.
  if (segments.length > MAX_SEGMENTS) {
    return json({
      available: false,
      reason: `Too long to read aloud (${segments.length} segments, limit ${MAX_SEGMENTS}).`,
      segments: segments.length
    });
  }

  const day = await audioDayCount(env);
  if (day.used + segments.length > AUDIO_DAY_LIMIT) {
    // Reported as unavailable rather than as an error: the client's answer to
    // "no server audio" is already the browser voice, and this is the same
    // answer for a different reason.
    return json({
      available: false,
      reason: `Daily speech limit reached (${day.used} of ${AUDIO_DAY_LIMIT} segments). It resets at midnight UTC.`,
      segments: segments.length
    });
  }

  return json({
    available: true,
    segments: segments.length,
    // Per-segment lengths, so the client can report progress proportional to
    // the text rather than counting segments as equal -- the last one is often
    // a fraction of the others.
    segmentChars: segments.map((s) => s.length),
    chars: segments.reduce((n, s) => n + s.length, 0),
    title: row.title,
    source: row.source
  });
}

async function getAudioSegment(env, id, index) {
  if (!env.AI) return fail(503, 'Workers AI is not configured.');

  const row = await env.DB.prepare(
    `SELECT title, body_text FROM article WHERE id = ?1 AND topic_id = ?2`
  ).bind(id, TOPIC_ID).first();
  if (!row) return fail(404, 'No such article.');

  const segments = segmentText(speechText(row));
  if (segments.length > MAX_SEGMENTS) return fail(413, 'Too long to read aloud.');
  // Out of range is a 404 rather than an empty 200: the client uses the end of
  // the range to know it has finished, and an empty body would play as silence.
  if (!Number.isInteger(index) || index < 0 || index >= segments.length) {
    return fail(404, 'No such segment.');
  }

  // Checked again here, not only in the manifest: the manifest is one snapshot
  // taken before a long listen, and the segment route is what actually spends.
  const day = await audioDayCount(env);
  if (day.used >= AUDIO_DAY_LIMIT) {
    return fail(429, `Daily speech limit reached (${AUDIO_DAY_LIMIT} segments). It resets at midnight UTC.`);
  }

  let audio;
  try {
    // Counted before generating rather than after: a request that dies partway
    // has still spent the neurons, and an uncounted failure is the one that
    // would let a retry loop run the allowance down.
    await bumpAudioDay(env, day.today);
    audio = await generateSegment(env, segments[index]);
  } catch (err) {
    // The reader falls back to the browser voice on this, so it must be a
    // clean failure rather than a hang or a half-written body.
    return fail(502, `Speech generation failed: ${String(err?.message || err)}`);
  }

  return new Response(audio.body, {
    headers: {
      'content-type': audio.contentType,
      // Private and brief. The audio is deterministic for a given text, but
      // storing it is the thing this design exists to avoid, and a long cache
      // here would just move the hoard into the browser.
      'cache-control': 'private, max-age=600'
    }
  });
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
  // Measured here rather than counted at ingest, because only a walk of the
  // bucket can see an object that was deleted. Settings is opened rarely and
  // the archive is ~1,800 objects a year, so this is one list call. §5.2
  let r2UsageBytes = null;
  if (env.RAW) {
    r2UsageBytes = await measureRawUsage(env).catch(() => cachedRawUsage(env));
  }
  // The pipeline runs somewhere else, nightly, and its failure mode is silence.
  // Settings is where you would look.
  const pipeline = await env.DB.prepare(
    `SELECT key, value FROM setting WHERE key IN (?1, ?2, ?3)`
  ).bind(PIPELINE_LAST_RUN, PIPELINE_LAST_COUNT, PIPELINE_LAST_VERSION).all();
  const marks = Object.fromEntries(pipeline.results.map((r) => [r.key, r.value]));

  return json({
    lapseWindowDays: await lapseWindow(env),
    pipelineLastRun: marks[PIPELINE_LAST_RUN] ?? null,
    pipelineLastCount: Number(marks[PIPELINE_LAST_COUNT] ?? 0),
    pipelineVersion: marks[PIPELINE_LAST_VERSION] ?? null,
    r2UsageBytes,
    r2UsageMb: r2UsageBytes === null ? null : Math.round(r2UsageBytes / 1024 / 1024),
    r2BudgetMb: RAW_BUDGET_BYTES / 1024 / 1024
  });
}

// Losing the archive deletes the project's entire value, so export ships in
// v1 rather than as a stretch goal. §3 "Store"
async function exportAll(env) {
  const articles = await env.DB.prepare(`SELECT * FROM article WHERE topic_id = ?1 ORDER BY id`).bind(TOPIC_ID).all();
  const events = await env.DB.prepare(`SELECT * FROM event ORDER BY id`).all();
  const tags = await env.DB.prepare(
    `SELECT at.article_id, t.name FROM article_tag at JOIN tag t ON t.id = at.tag_id`
  ).all();
  const settings = await env.DB.prepare(`SELECT key, value FROM setting ORDER BY key`).all();
  const topics = await env.DB.prepare(`SELECT * FROM topic ORDER BY id`).all();
  // A manifest of what the export expects to find in R2, not the blobs
  // themselves -- a restore reads this to know what raw captures are missing,
  // it does not re-upload them. §3 "Store"
  const rawHtmlKeys = articles.results.map((a) => a.raw_html_key).filter((k) => k != null);

  const body = JSON.stringify(
    {
      exported_at: nowIso(),
      schema_version: 1,
      articles: articles.results,
      events: events.results,
      article_tags: tags.results,
      settings: settings.results,
      topics: topics.results,
      raw_html_keys: rawHtmlKeys
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

// -------------------------------------------------------------- discovery

const CANDIDATE_COLUMNS = `id, batch_id, feed_source_id, url, url_normalized, title, summary, source, author, published_at, score, status, created_at`;

function checkDiscoverKey(request, env) {
  if (!env.DISCOVER_KEY) return false;
  const header = request.headers.get('x-discover-key') || '';
  return header.length > 0 && header === env.DISCOVER_KEY;
}

// ------------------------------------------------------- the V2 pipeline
//
// §8 Stage 1 runs in GitHub Actions, in Python, because the feature pass loops
// over megabytes of text and a Worker gets 10ms of CPU per invocation. These
// two routes are the whole interface: hand out work, take back features.
//
// Keyed with the same x-discover-key the candidate ingest uses rather than a
// second secret. One machine-facing credential is easier to rotate than two,
// and both callers are the same GitHub Actions runner.

const PIPELINE_LAST_RUN = 'pipeline_last_run';
const PIPELINE_LAST_COUNT = 'pipeline_last_count';
const PIPELINE_LAST_VERSION = 'pipeline_last_version';

// Articles that have text and no features at this version. Sending the version
// means a changed extractor re-does the corpus without anything having to
// remember which rows are stale.
async function getPipelineWork(env, url) {
  const version = (url.searchParams.get('version') || '').trim();
  if (!version) return fail(400, 'A version is required.');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, a.url, a.source, a.body_text, a.word_count, a.raw_html_key
     FROM article a
     WHERE a.topic_id = ?1
       AND a.body_text IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM article_feature f
         WHERE f.article_id = a.id AND f.version = ?2
       )
     ORDER BY a.id
     LIMIT ?3`
  ).bind(TOPIC_ID, version, limit).all();

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM article a
     WHERE a.topic_id = ?1 AND a.body_text IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM article_feature f WHERE f.article_id = a.id AND f.version = ?2)`
  ).bind(TOPIC_ID, version).first();

  return json({ version, articles: results, remaining: remaining?.n ?? 0 });
}

async function putPipelineFeatures(env, request) {
  const body = await request.json().catch(() => ({}));
  const rows = body.features;
  const version = String(body.version || '').trim();
  if (!version) return fail(400, 'A version is required.');
  if (!Array.isArray(rows) || !rows.length) return fail(400, 'No features provided.');

  const statements = [];
  let accepted = 0;
  for (const row of rows.slice(0, 200)) {
    const id = Number(row.article_id);
    if (!Number.isInteger(id)) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO article_feature (article_id, version, score, explain, payload, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(article_id, version) DO UPDATE SET
           score = excluded.score, explain = excluded.explain,
           payload = excluded.payload, computed_at = excluded.computed_at`
      ).bind(
        id, version,
        Number(row.score) || 0,
        String(row.explain || '').slice(0, 500),
        JSON.stringify(row.payload ?? {}),
        nowIso()
      )
    );
    accepted += 1;
  }
  if (!accepted) return fail(400, 'No usable features provided.');

  // The canary. A nightly job that quietly stops is invisible for a week --
  // §9.6, and the shape of failure this project has already met twice. The
  // number is recorded next to the timestamp so "it ran" and "it did anything"
  // are separate questions.
  statements.push(
    env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(PIPELINE_LAST_RUN, nowIso()),
    env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(PIPELINE_LAST_COUNT, String(accepted)),
    env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(PIPELINE_LAST_VERSION, version)
  );

  await env.DB.batch(statements);
  return json({ accepted, version });
}

async function ingestCandidates(env, request) {
  const body = await request.json().catch(() => ({}));
  const items = body.candidates;
  if (!Array.isArray(items) || !items.length) return fail(400, 'No candidates provided.');

  const batchId = body.batchId || crypto.randomUUID();
  const ts = nowIso();
  let inserted = 0;

  const statements = [];
  for (const item of items.slice(0, 50)) {
    const url = (item.url || '').trim();
    const normalized = item.url_normalized || url;
    // RSS is XML, so `&amp;` is mandatory there and `&#8217;` ubiquitous.
    // discover/ does no decoding by design -- it stays dependency-free -- so
    // this is where it has to happen, or the Discover screen renders raw
    // entities and any candidate promoted to an article carries them in. V1-30
    const title = decodeEntities((item.title || '').trim());
    if (!url || !title) continue;

    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO candidate
           (batch_id, feed_source_id, url, url_normalized, title, summary, source, author, published_at, score, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      ).bind(
        batchId,
        item.feed_source_id || null,
        url,
        normalized,
        title,
        decodeEntities((item.summary || '').trim()).slice(0, 500),
        decodeEntities((item.source || '').trim()).slice(0, 200),
        item.author ? decodeEntities(item.author) : null,
        item.published_at || null,
        item.score || 0,
        ts
      )
    );
    inserted++;
  }

  if (statements.length) await env.DB.batch(statements);

  return json({ batchId, inserted }, { status: 201 });
}

async function getCandidates(env) {
  const latestBatch = await env.DB.prepare(
    `SELECT batch_id FROM candidate WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`
  ).first();

  if (!latestBatch) return json({ candidates: [], batchId: null, total: 0 });

  const { results } = await env.DB.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidate
     WHERE batch_id = ?1 AND status = 'pending'
     ORDER BY score DESC`
  ).bind(latestBatch.batch_id).all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM candidate WHERE status = 'pending'`
  ).first();

  return json({ candidates: results, batchId: latestBatch.batch_id, total: total?.n ?? 0 });
}

async function keepCandidate(env, id) {
  const row = await env.DB.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidate WHERE id = ?1 AND status = 'pending'`
  ).bind(id).first();
  if (!row) return fail(404, 'Candidate not found or already resolved.');

  const existing = await env.DB.prepare(
    `SELECT id FROM article WHERE topic_id = ?1 AND url_normalized = ?2`
  ).bind(TOPIC_ID, row.url_normalized).first();

  if (existing) {
    await env.DB.prepare(`UPDATE candidate SET status = 'kept' WHERE id = ?1`).bind(id).run();
    return json({ article: { id: existing.id }, alreadyExists: true });
  }

  const extracted = await extractArticle(row.url_normalized);
  const ts = nowIso();

  let record;
  let fetchError = null;

  if (extracted.ok) {
    record = {
      title: extracted.title || row.title,
      source: extracted.source || row.source || sourceFromUrl(row.url_normalized),
      author: extracted.author || row.author,
      published_at: extracted.published_at || row.published_at,
      summary: extracted.summary || row.summary,
      body_text: extracted.body_text,
      word_count: extracted.word_count,
      fetch_status: 'ok',
      raw_html_key: null,
    };
    if (env.RAW && extracted.html) {
      record.raw_html_key = await captureRaw(env, extracted.html);
    }
  } else {
    fetchError = extracted.error;
    record = {
      title: row.title,
      source: row.source || sourceFromUrl(row.url_normalized),
      author: row.author,
      published_at: row.published_at,
      summary: row.summary,
      body_text: null,
      word_count: 0,
      fetch_status: extracted.fetch_status,
      raw_html_key: null,
    };
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO article
       (topic_id, url, url_normalized, title, source, author, published_at,
        body_text, summary, raw_html_key, added_at, word_count, fetch_status, fetched_at, origin)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'auto')
     RETURNING ${LIST_COLUMNS}`
  ).bind(
    TOPIC_ID, row.url, row.url_normalized, record.title, record.source, record.author,
    record.published_at, record.body_text, record.summary, record.raw_html_key,
    ts, record.word_count, record.fetch_status, ts
  ).first();

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO event (article_id, type, created_at) VALUES (?1, 'added', ?2)`).bind(inserted.id, ts),
    env.DB.prepare(`UPDATE candidate SET status = 'kept' WHERE id = ?1`).bind(id),
  ]);

  return json({ article: shape(inserted), fetchError }, { status: 201 });
}

async function skipCandidate(env, id) {
  const { changes } = await env.DB.prepare(
    `UPDATE candidate SET status = 'skipped' WHERE id = ?1 AND status = 'pending'`
  ).bind(id).run();
  if (!changes) return fail(404, 'Candidate not found or already resolved.');
  return json({ ok: true });
}

async function batchResolveCandidates(env, request) {
  const body = await request.json().catch(() => ({}));
  const actions = body.actions;
  if (!Array.isArray(actions) || !actions.length) return fail(400, 'No actions provided.');

  const results = [];
  for (const { id, action } of actions.slice(0, 50)) {
    if (action === 'keep') {
      const res = await keepCandidate(env, id);
      const data = await res.json();
      results.push({ id, action, ...data });
    } else if (action === 'skip') {
      await skipCandidate(env, id);
      results.push({ id, action, ok: true });
    }
  }
  return json({ results });
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

    // Discovery script authenticates with a shared key, not a cookie.
    if (path.startsWith('/api/pipeline/')) {
      if (!checkDiscoverKey(request, env)) return fail(401, 'Bad or missing pipeline key.');
      if (path === '/api/pipeline/work' && request.method === 'GET') return await getPipelineWork(env, url);
      if (path === '/api/pipeline/features' && request.method === 'POST') return await putPipelineFeatures(env, request);
      return fail(404, 'No such endpoint.');
    }

    if (path === '/api/candidates' && request.method === 'POST') {
      if (!checkDiscoverKey(request, env)) return fail(401, 'Invalid discover key.');
      return await ingestCandidates(env, request);
    }

    if (!(await isAuthed(request, env))) return fail(401, 'Not signed in.');

    try {
      if (path === '/api/feed' && request.method === 'GET') return await getFeed(env, url);
      if (path === '/api/facets' && request.method === 'GET') return await getFacets(env);
      if (path === '/api/articles' && request.method === 'POST') return await addArticle(env, request);
      if (path === '/api/settings') return await settings(env, request);
      if (path === '/api/export' && request.method === 'GET') return await exportAll(env);

      if (path === '/api/candidates' && request.method === 'GET') return await getCandidates(env);
      if (path === '/api/candidates/batch' && request.method === 'POST') return await batchResolveCandidates(env, request);

      const candidateMatch = path.match(/^\/api\/candidates\/(\d+)\/(keep|skip)$/);
      if (candidateMatch) {
        const id = Number(candidateMatch[1]);
        if (candidateMatch[2] === 'keep') return await keepCandidate(env, id);
        if (candidateMatch[2] === 'skip') return await skipCandidate(env, id);
      }

      // Audio segments carry an index, so they are matched before the
      // single-action pattern below.
      const audioSeg = path.match(/^\/api\/articles\/(\d+)\/audio\/(\d+)$/);
      if (audioSeg && request.method === 'GET') {
        return await getAudioSegment(env, Number(audioSeg[1]), Number(audioSeg[2]));
      }

      const match = path.match(/^\/api\/articles\/(\d+)(?:\/(open|listen|resolve|star|refetch|raw|audio))?$/);
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
        if (action === 'raw' && request.method === 'GET') return await getRawHtml(env, id);
        if (action === 'audio' && request.method === 'GET') return await getAudioManifest(env, id);
        return fail(405, 'Method not allowed.');
      }

      return fail(404, 'No such endpoint.');
    } catch (err) {
      return fail(500, String((err && err.message) || err));
    }
  }
};
