// V1-28. Two things are being pinned here.
//
// First, that Today means "what you chose today" rather than "what arrived
// today". A poll that finds forty links must not be able to flood the one page
// whose entire value is that it is short enough to finish. §7.7
//
// Second, that Today and Pending stay exact complements. They are derived at
// read time from the same three columns, and the failure mode of a derived
// pair is an item that satisfies neither predicate and is therefore invisible
// -- present in the archive, absent from every surface. Several tests below
// exist only to catch that.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, callJson, dayStart, isoDaysAgo, resetDb, seedArticle } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const feed = (params = {}) =>
  callJson(`/api/feed?${new URLSearchParams({ dayStart: dayStart(), ...params })}`);

const add = (payload) =>
  callJson('/api/articles', { method: 'POST', body: JSON.stringify(payload) });

const titles = (rows) => rows.map((r) => r.title);

describe('origin routing', () => {
  it('puts a machine-found item in Pending even though it arrived today', async () => {
    await seedArticle({ title: 'found by a poll', origin: 'auto' });

    const { body } = await feed();

    expect(titles(body.today)).toEqual([]);
    expect(titles(body.pending)).toEqual(['found by a poll']);
  });

  it('leaves a hand-added item on Today, which is the whole point of the split', async () => {
    await seedArticle({ title: 'pasted by hand', origin: 'manual' });

    const { body } = await feed();

    expect(titles(body.today)).toEqual(['pasted by hand']);
    expect(titles(body.pending)).toEqual([]);
  });

  it('defaults origin to manual, so nothing written before this column existed moves', async () => {
    await seedArticle({ title: 'no origin given' });

    const { body } = await feed();

    expect(titles(body.today)).toEqual(['no origin given']);
    expect(body.today[0].origin).toBe('manual');
  });

  it('keeps Today and Pending exact complements across every combination', async () => {
    // The four cases the two predicates have to partition between them.
    await seedArticle({ title: 'manual today', origin: 'manual' });
    await seedArticle({ title: 'manual old', origin: 'manual', added_at: isoDaysAgo(3) });
    await seedArticle({ title: 'auto today', origin: 'auto' });
    await seedArticle({ title: 'auto old', origin: 'auto', added_at: isoDaysAgo(3) });

    const { body } = await feed();

    expect(titles(body.today)).toEqual(['manual today']);
    expect(titles(body.pending).sort()).toEqual(['auto old', 'auto today', 'manual old']);

    // No row is on both surfaces, and no undecided row is missing from both.
    const surfaced = [...body.today, ...body.pending].map((r) => r.id);
    expect(new Set(surfaced).size).toBe(surfaced.length);

    const undecided = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM article WHERE status = 'new'`
    ).first();
    expect(surfaced.length).toBe(undecided.n);
  });

  it('lapses a machine-found item on the same clock as any other', async () => {
    // Pending is where these live, so the lapse window has to reach them --
    // otherwise a poll builds a pile that never ages out. §9.4
    const { id } = await seedArticle({ title: 'old poll result', origin: 'auto', added_at: isoDaysAgo(20) });

    await feed();

    const row = await env.DB.prepare(`SELECT status, origin FROM article WHERE id = ?1`).bind(id).first();
    expect(row.status).toBe('lapsed');
    expect(row.origin).toBe('auto');
  });

  it('counts machine-found items in pendingTotal', async () => {
    await seedArticle({ origin: 'auto' });
    await seedArticle({ origin: 'auto' });
    await seedArticle({ origin: 'manual', added_at: isoDaysAgo(2) });

    const { body } = await feed();

    expect(body.pendingTotal).toBe(3);
  });
});

describe('ingest with origin and defer', () => {
  it('accepts origin:auto and routes the new item to Pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<!doctype html><html><head><title>Polled</title></head><body></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } })
    ));

    const { body, status } = await add({ url: 'https://example.com/polled', origin: 'auto' });
    expect(status).toBe(201);
    expect(body.article.origin).toBe('auto');

    const { body: f } = await feed();
    expect(titles(f.today)).toEqual([]);
    expect(f.pending.map((r) => r.id)).toEqual([body.article.id]);
  });

  it('does not fetch the page at all when defer is set', async () => {
    // This is the property that keeps a scheduled poll inside the free plan's
    // 50-subrequest and 10ms CPU ceilings: discovering N links costs one
    // subrequest per source, not one per article. §7.4
    const spy = vi.fn(async () => new Response('should never be requested', { status: 200 }));
    vi.stubGlobal('fetch', spy);

    const { body, status } = await add({
      url: 'https://example.com/deferred',
      title: 'Title from the feed itself',
      origin: 'auto',
      defer: true
    });

    expect(status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
    expect(body.article.title).toBe('Title from the feed itself');
    expect(body.article.fetch_status).toBeNull();

    const row = await env.DB.prepare(
      `SELECT body_text, fetched_at FROM article WHERE id = ?1`
    ).bind(body.article.id).first();
    expect(row.body_text).toBeNull();
    // Never fetched is not the same as fetched and empty -- the refetch path
    // keys on this, and so does the reader's "paste the text" block.
    expect(row.fetched_at).toBeNull();
  });

  it('still fetches when defer is absent, so the hand-paste path is untouched', async () => {
    const spy = vi.fn(async () =>
      new Response('<!doctype html><html><head><title>Fetched</title></head><body></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } })
    );
    vi.stubGlobal('fetch', spy);

    const { body } = await add({ url: 'https://example.com/normal' });

    expect(spy).toHaveBeenCalled();
    expect(body.article.origin).toBe('manual');
    expect(body.article.fetch_status).toBe('ok');
  });

  it('treats an unknown origin as manual rather than writing it', async () => {
    // The column has a CHECK constraint, so an unsanitised value would be a
    // 500 at the INSERT. It is coerced instead.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    const { body, status } = await add({ url: 'https://example.com/odd', origin: 'nonsense' });

    expect(status).toBe(201);
    expect(body.article.origin).toBe('manual');
  });

  it('a deferred item is still deduplicated by URL', async () => {
    const first = await add({ url: 'https://example.com/same', origin: 'auto', defer: true });
    expect(first.status).toBe(201);

    // The poller will re-see the same link tomorrow; it must not create a
    // second row for it.
    const second = await add({ url: 'https://example.com/same?utm_source=whatever', origin: 'auto', defer: true });
    expect(second.status).toBe(409);
    expect(second.body.duplicate).toBe(true);
  });
});

// D8 (V1-30). PATCH gained an explicit `summary` so the entity repair can fix
// stored summaries. The guard it must NOT break is the derived one: pasting
// text into a failed-fetch article fills an empty summary but never replaces
// a summary you have already read.
describe('explicit summary on PATCH', () => {
  const patch = (id, payload) =>
    callJson(`/api/articles/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });

  it('overwrites an existing summary when one is named', async () => {
    const { id } = await seedArticle({ summary: 'Meta&#039;s agent, escaped' });

    const { body } = await patch(id, { summary: "Meta's agent, repaired" });

    expect(body.article.summary).toBe("Meta's agent, repaired");
  });

  it('still refuses to overwrite a summary as a side effect of pasting text', async () => {
    const { id } = await seedArticle({ summary: 'A summary you have read' });

    await patch(id, { body_text: 'Some pasted article text that is long enough to summarize from.' });

    const row = await env.DB.prepare('SELECT summary FROM article WHERE id = ?1').bind(id).first();
    expect(row.summary).toBe('A summary you have read');
  });

  it('still fills an empty summary from pasted text', async () => {
    const { id } = await seedArticle({ summary: '' });

    await patch(id, { body_text: 'Some pasted article text that is long enough to summarize from.' });

    const row = await env.DB.prepare('SELECT summary FROM article WHERE id = ?1').bind(id).first();
    expect(row.summary).not.toBe('');
  });

  it('lets an explicit summary win when text is pasted in the same request', async () => {
    // Both paths want to write `summary`; assigning one column twice in a
    // single UPDATE is ambiguous, so the explicit value takes it.
    const { id } = await seedArticle({ summary: '' });

    const { body } = await patch(id, {
      body_text: 'Some pasted article text that is long enough to summarize from.',
      summary: 'The summary I actually want'
    });

    expect(body.article.summary).toBe('The summary I actually want');
  });

  it('ignores a summary that is not a string, rather than blanking the field', async () => {
    const { id } = await seedArticle({ summary: 'unchanged' });

    await patch(id, { summary: null });
    await patch(id, { summary: 42 });

    const row = await env.DB.prepare('SELECT summary FROM article WHERE id = ?1').bind(id).first();
    expect(row.summary).toBe('unchanged');
  });
});
