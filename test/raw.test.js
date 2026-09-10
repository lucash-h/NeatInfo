// §5.4's ten-minute discipline -- "check you can actually extract what §8
// wants" -- needs the raw capture to be readable. GET /api/articles/:id/raw is
// what makes it performable at all; scripts/validate-capture.mjs is what walks
// it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, call, callJson, resetDb, seedArticle } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HTML = `<!doctype html><html><head><title>Kept raw</title></head>
  <body><article><p>A paragraph long enough to clear the forty character floor the extractor uses.</p>
  <a href="https://elsewhere.example/paper">a citation</a></article></body></html>`;

describe('GET /api/articles/:id/raw', () => {
  it('streams the stored HTML back', async () => {
    const key = `raw/test-${crypto.randomUUID()}.html`;
    await env.RAW.put(key, HTML, { httpMetadata: { contentType: 'text/html' } });
    const { id } = await seedArticle({ raw_html_key: key, status: 'kept' });

    const res = await call(`/api/articles/${id}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(HTML);
  });

  it('404s an article that has no raw copy', async () => {
    const { id } = await seedArticle({ raw_html_key: null });
    const { status, body } = await callJson(`/api/articles/${id}/raw`);
    expect(status).toBe(404);
    expect(body.error).toBe('No raw copy was kept for that one.');
  });

  it('404s an article that does not exist', async () => {
    const { status, body } = await callJson('/api/articles/999999/raw');
    expect(status).toBe(404);
    expect(body.error).toBe('No such article.');
  });

  it('404s a key that is recorded but gone from the bucket', async () => {
    const { id } = await seedArticle({ raw_html_key: 'raw/never-written.html' });
    const { status, body } = await callJson(`/api/articles/${id}/raw`);
    expect(status).toBe(404);
    expect(body.error).toBe('The raw copy is no longer in R2.');
  });

  it('requires a session like every other article route', async () => {
    const { id } = await seedArticle({ raw_html_key: 'raw/whatever.html' });
    expect((await call(`/api/articles/${id}/raw`, {}, { authed: false })).status).toBe(401);
  });

  it('405s a write to it', async () => {
    const { id } = await seedArticle();
    expect((await call(`/api/articles/${id}/raw`, { method: 'POST', body: '{}' })).status).toBe(405);
  });

  it('serves the copy an ordinary add captured, end to end', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));

    const { body } = await callJson('/api/articles', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/captured' })
    });

    const res = await call(`/api/articles/${body.article.id}/raw`);
    expect(res.status).toBe(200);
    // The whole page, not the extracted text: §8's structural signals live in
    // the markup the extractor throws away.
    expect(await res.text()).toContain('<a href="https://elsewhere.example/paper">');
  });
});

// The §5.4 script's analysis half, which is the part that can be wrong
// quietly. The CLI half is not exercised here -- it needs a deployed app.
describe('validate-capture analysis', () => {
  it('separates outbound links from same-site ones', async () => {
    const { analyzeRaw } = await import('../scripts/validate-capture.mjs');
    const html = `<body><p>A paragraph of prose long enough to be counted as a real chunk here.</p>
      <a href="https://example.com/more">same site</a>
      <a href="https://arxiv.org/abs/2401.00001">a paper</a>
      <a href="#section">an anchor</a></body>`;

    const a = analyzeRaw(html, 'https://www.example.com/post');
    expect(a.links).toBe(2);
    expect(a.outbound).toBe(1);
    expect(a.outboundHosts).toBe(1);
  });

  it('ignores script and style text when counting words and chunks', async () => {
    const { analyzeRaw } = await import('../scripts/validate-capture.mjs');
    const html = `<body><script>var junk = "a long string of javascript that is not prose at all";</script>
      <p>The only real paragraph on this page, comfortably past the forty character floor.</p></body>`;

    const a = analyzeRaw(html);
    expect(a.chunks).toBe(1);
    expect(a.words).toBeLessThan(20);
  });

  it('measures numeric density, which is §8 stage 1\'s cheapest signal', async () => {
    const { analyzeRaw } = await import('../scripts/validate-capture.mjs');
    const prose = analyzeRaw('<p>' + 'word '.repeat(40) + '</p>');
    const table = analyzeRaw('<p>' + '12.4 '.repeat(40) + '</p>');
    expect(prose.numericDensity).toBe(0);
    expect(table.numericDensity).toBe(1);
  });

  it('calls a nav-bar-only capture thin rather than usable', async () => {
    const { analyzeRaw, verdict } = await import('../scripts/validate-capture.mjs');
    expect(verdict(analyzeRaw('<body><nav><p>Home About Contact Subscribe now for more</p></nav></body>')))
      .toMatch(/THIN/);
    const real = '<p>' + 'sentence about a result '.repeat(30) + '</p>'.repeat(1) +
      '<p>' + 'another paragraph of analysis '.repeat(30) + '</p>' +
      '<p>' + 'and a third one for the chunk count '.repeat(20) + '</p>' +
      '<a href="https://elsewhere.example/x">cite</a>';
    expect(verdict(analyzeRaw(real, 'https://example.com/p'))).toBe('usable');
  });
});
