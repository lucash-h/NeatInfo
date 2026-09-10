// V1-26. D1 rejects a single value over roughly 1 MB with
// `D1_ERROR: string or blob too big: SQLITE_TOOBIG`, so before this guard a
// long page 500'd at the INSERT and the article was lost outright -- the exact
// failure §3 "Pull" forbids. The raw HTML is already in R2, so the cap costs
// nothing that is not recoverable. §5.2
//
// Note what these tests can and cannot prove: the local D1 that miniflare runs
// is plain SQLite, whose own SQLITE_MAX_LENGTH is 1 GB, so it happily accepts a
// 1 MB value and the production rejection cannot be reproduced here (checked by
// executing exactly that insert). The tests therefore assert the guard's
// behaviour -- an over-cap add returns 201 with a usable, under-cap row -- and
// the cap itself is set against D1's documented ~1 MB per-value limit.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, callJson, resetDb } from './helpers.js';
import { truncateBodyText, BODY_TEXT_LIMIT, TRUNCATION_MARK } from '../worker/extract.js';

beforeAll(applySchema);
beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const bytes = (s) => new TextEncoder().encode(s).byteLength;

// Comfortably over the cap: ~1.5 MB, which is what a long transcript or a
// book-length page produces.
const OVER_CAP = 'Paragraph about scaling and its discontents. '.repeat(34000);

describe('truncateBodyText', () => {
  it('leaves ordinary article text alone', () => {
    const text = 'A five thousand word article is about thirty kilobytes. '.repeat(500);
    expect(bytes(text)).toBeLessThan(BODY_TEXT_LIMIT);
    expect(truncateBodyText(text)).toEqual({ text, truncated: false });
  });

  it('passes null and empty text through untouched', () => {
    expect(truncateBodyText(null)).toEqual({ text: null, truncated: false });
    expect(truncateBodyText('')).toEqual({ text: '', truncated: false });
  });

  it('cuts over-cap text to under the limit and says that it did', () => {
    const { text, truncated } = truncateBodyText(OVER_CAP);
    expect(truncated).toBe(true);
    expect(bytes(text)).toBeLessThanOrEqual(BODY_TEXT_LIMIT);
    expect(text.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(text.startsWith('Paragraph about scaling')).toBe(true);
  });

  it('does not stop mid-word', () => {
    const { text } = truncateBodyText(OVER_CAP);
    const body = text.slice(0, -TRUNCATION_MARK.length);
    expect(body.endsWith('discontents.')).toBe(true);
  });

  it('stays under the cap for multi-byte text, and never splits a character', () => {
    // Every character is three bytes, so a naive character-count cap would go
    // three times over the limit and a naive byte slice would cut one in half.
    const { text, truncated } = truncateBodyText('日本語のテキスト。'.repeat(80000));
    expect(truncated).toBe(true);
    expect(bytes(text)).toBeLessThanOrEqual(BODY_TEXT_LIMIT);
    expect(text).not.toContain('�');
  });

  it('honours a smaller cap when one is passed', () => {
    const { text, truncated } = truncateBodyText('word '.repeat(500), 400);
    expect(truncated).toBe(true);
    expect(bytes(text)).toBeLessThanOrEqual(400);
  });
});

describe('adding an article whose body is over the cap', () => {
  it('returns 201 with a usable row instead of a 500', async () => {
    const { status, body } = await callJson('/api/articles', {
      method: 'POST',
      body: JSON.stringify({ text: `A very long transcript\n\n${OVER_CAP}`, source: 'example.com' })
    });

    expect(status).toBe(201);
    expect(body.bodyTruncated).toBe(true);
    expect(body.article.title).toBe('A very long transcript');
    expect(body.article.word_count).toBeGreaterThan(1000);

    const row = await env.DB.prepare(`SELECT body_text, summary FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(bytes(row.body_text)).toBeLessThanOrEqual(BODY_TEXT_LIMIT);
    expect(row.body_text.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(row.summary).toBeTruthy();

    // The row is a real archive row: it is on Today and it is searchable.
    const feed = await callJson('/api/feed');
    expect(feed.body.today.map((a) => a.id)).toContain(body.article.id);
  });

  it('truncates an over-cap page fetched from a URL, and still keeps the raw HTML', async () => {
    await env.RAW.delete('_usage');
    const html = `<!doctype html><html><head><title>Enormous</title></head><body><article>` +
      `<p>${OVER_CAP.slice(0, 700 * 1024)}</p></article></body></html>`;
    vi.stubGlobal('fetch', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));

    const { status, body } = await callJson('/api/articles', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/enormous-body' })
    });

    expect(status).toBe(201);
    expect(body.bodyTruncated).toBe(true);
    expect(body.article.fetch_status).toBe('ok');

    const row = await env.DB.prepare(`SELECT body_text, raw_html_key FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(bytes(row.body_text)).toBeLessThanOrEqual(BODY_TEXT_LIMIT);
    // Nothing is truly lost: the whole page is in R2. §5.2
    expect(row.raw_html_key).toMatch(/^raw\//);
    expect((await (await env.RAW.get(row.raw_html_key)).text()).length).toBe(html.length);
  });

  it('applies the same cap to a paste that rescues a failed fetch (V1-14 path)', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));
    const added = await callJson('/api/articles', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/needs-text' })
    });

    const { status, body } = await callJson(`/api/articles/${added.body.article.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body_text: OVER_CAP })
    });

    expect(status).toBe(200);
    expect(body.bodyTruncated).toBe(true);
    expect(body.article.fetch_status).toBe('pasted');
    expect(bytes(body.article.body_text)).toBeLessThanOrEqual(BODY_TEXT_LIMIT);
    expect(body.article.word_count).toBeGreaterThan(1000);
  });
});
