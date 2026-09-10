// §9.5's narrow slice (decision D1): the PDF is not extractable on this
// runtime, but the /abs/ page beside it is plain HTML. Both link shapes point
// at the abstract page, and the abstract becomes the body text. No PDF
// parsing, no new dependency.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeUrl, isArxivAbs } from '../worker/url.js';
import { extractArxiv } from '../worker/extract.js';
import { applySchema, callJson, resetDb } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

// Trimmed to the elements the extractor reads, in the shape arXiv serves them.
const ABS_PAGE = `<!doctype html><html><head>
  <title>[2401.12345] Sparse attention, revisited</title>
  <meta name="citation_title" content="Sparse attention, revisited">
  <meta name="citation_author" content="Ng, A.">
  <meta name="citation_author" content="Sutskever, I.">
  <meta name="citation_date" content="2024/01/16">
  <meta property="og:description" content="ignored in favour of the abstract block">
  </head><body>
  <h1 class="title mathjax"><span class="descriptor">Title:</span>Sparse attention, revisited</h1>
  <div class="authors"><span class="descriptor">Authors:</span><a href="/a/ng">A. Ng</a>, <a href="/a/sutskever">I. Sutskever</a></div>
  <blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span>
  We revisit sparse attention and show that a fixed pattern recovers most of the
  quality of full attention at a fraction of the cost, across three model scales.
  </blockquote></body></html>`;

const htmlResponse = (html) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('arXiv URLs', () => {
  it('rewrites a PDF link to the abstract page', () => {
    expect(normalizeUrl('https://arxiv.org/pdf/2401.12345')).toBe('https://arxiv.org/abs/2401.12345');
    expect(normalizeUrl('https://arxiv.org/pdf/2401.12345v2.pdf')).toBe('https://arxiv.org/abs/2401.12345v2');
  });

  it('leaves an abstract link where it is', () => {
    expect(normalizeUrl('https://arxiv.org/abs/2401.12345')).toBe('https://arxiv.org/abs/2401.12345');
  });

  it('makes the PDF and the abstract one item for duplicate detection', () => {
    expect(normalizeUrl('https://arxiv.org/pdf/2401.12345.pdf'))
      .toBe(normalizeUrl('https://www.arxiv.org/abs/2401.12345?context=cs.LG'));
  });

  it('handles the legacy id shape', () => {
    expect(normalizeUrl('https://arxiv.org/pdf/math.GT/0309136')).toBe('https://arxiv.org/abs/math.GT/0309136');
  });

  it('leaves other arxiv.org pages alone', () => {
    expect(normalizeUrl('https://arxiv.org/list/cs.LG/recent')).toBe('https://arxiv.org/list/cs.LG/recent');
    expect(isArxivAbs('https://arxiv.org/list/cs.LG/recent')).toBe(false);
  });

  it('does not touch a lookalike host', () => {
    expect(normalizeUrl('https://notarxiv.org/pdf/2401.12345')).toBe('https://notarxiv.org/pdf/2401.12345');
  });
});

describe('extractArxiv', () => {
  it('reads title, authors, date and abstract from the abstract page', async () => {
    const paper = await extractArxiv(ABS_PAGE);
    expect(paper.title).toBe('Sparse attention, revisited');
    expect(paper.author).toBe('Ng, A., Sutskever, I.');
    expect(paper.published_at).toBe('2024-01-16');
    expect(paper.source).toBe('arXiv');
    expect(paper.body_text).toMatch(/^We revisit sparse attention/);
    expect(paper.body_text).not.toMatch(/Abstract:/);
    expect(paper.word_count).toBeGreaterThan(20);
  });

  it('falls back to the visible blocks when the citation meta is missing', async () => {
    const paper = await extractArxiv(ABS_PAGE.replace(/<meta name="citation_[^>]*>/g, ''));
    expect(paper.title).toBe('Sparse attention, revisited');
    expect(paper.author).toBe('A. Ng, I. Sutskever');
    expect(paper.published_at).toBeNull();
  });

  it('returns null for a page that is not an abstract page, so the generic path runs', async () => {
    expect(await extractArxiv('<html><body><p>A listing page with no abstract at all.</p></body></html>'))
      .toBeNull();
  });

  it('truncates a long author list rather than storing hundreds of names', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `<meta name="citation_author" content="Author ${i}">`).join('');
    const paper = await extractArxiv(ABS_PAGE.replace('</head>', many + '</head>'));
    expect(paper.author.endsWith(' et al.')).toBe(true);
    expect(paper.author.split(',').length).toBeLessThan(12);
  });
});

describe('adding an arXiv paper', () => {
  const add = (url) => callJson('/api/articles', { method: 'POST', body: JSON.stringify({ url }) });

  it('creates a fully populated item from a PDF link', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url) => {
      seen.push(String(url));
      return htmlResponse(ABS_PAGE);
    });

    const { status, body } = await add('https://arxiv.org/pdf/2401.12345v2.pdf');

    expect(status).toBe(201);
    // The abstract page was fetched, not the PDF: the fetch follows the
    // normalized URL, which is what makes this work at all.
    expect(seen[0]).toBe('https://arxiv.org/abs/2401.12345v2');
    expect(body.article.fetch_status).toBe('ok');
    expect(body.article.title).toBe('Sparse attention, revisited');
    expect(body.article.source).toBe('arXiv');
    expect(body.article.author).toBe('Ng, A., Sutskever, I.');
    expect(body.article.published_at).toBe('2024-01-16');
    expect(body.article.summary).toMatch(/^We revisit sparse attention/);
  });

  it('treats the abstract link as a duplicate of the PDF link', async () => {
    vi.stubGlobal('fetch', async () => htmlResponse(ABS_PAGE));
    const first = await add('https://arxiv.org/abs/2401.12345');
    expect(first.status).toBe(201);

    const second = await add('https://arxiv.org/pdf/2401.12345.pdf');
    expect(second.status).toBe(409);
    expect(second.body.article.id).toBe(first.body.article.id);
  });

  it('makes the abstract searchable as body text', async () => {
    vi.stubGlobal('fetch', async () => htmlResponse(ABS_PAGE));
    const { body } = await add('https://arxiv.org/abs/2401.99999');
    await callJson(`/api/articles/${body.article.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status: 'kept' })
    });

    const feed = await callJson('/api/feed?q=sparse attention');
    expect(feed.body.archive.map((a) => a.id)).toContain(body.article.id);
  });
});
