// §3 "Pull". The rule that matters most here is the last one: a failed fetch
// still creates the item -- never a dead end.
//
// vitest-pool-workers 0.22 no longer exports `fetchMock` from `cloudflare:test`,
// so outbound requests are stubbed by replacing the global `fetch` that
// worker/extract.js calls.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, callJson, countEvents, resetDb } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const PARAGRAPH =
  'This paragraph is comfortably longer than the forty character floor the body extractor uses to ignore page chrome.';

function page({ meta = '', title = 'Fallback title', body = PARAGRAPH } = {}) {
  return `<!doctype html><html><head>${meta}<title>${title}</title></head>
    <body><nav><p>Skip this navigation text which is also long enough to count.</p></nav>
    <article><p>${body}</p></article></body></html>`;
}

function stubFetch(handler) {
  const spy = vi.fn(handler);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const htmlResponse = (html) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

const add = (payload) =>
  callJson('/api/articles', { method: 'POST', body: JSON.stringify(payload) });

describe('adding by URL', () => {
  it('extracts title, source, author, date and summary from meta tags', async () => {
    stubFetch(async () =>
      htmlResponse(page({
        meta: `<meta property="og:title" content="Scaling laws, revisited">
               <meta property="og:description" content="A short standfirst from the page itself.">
               <meta property="og:site_name" content="Example Review">
               <meta name="author" content="A. Writer">
               <meta property="article:published_time" content="2026-02-03T09:00:00Z">`
      }))
    );

    const { status, body } = await add({ url: 'https://www.example.com/scaling/?utm_source=x' });

    expect(status).toBe(201);
    expect(body.article.title).toBe('Scaling laws, revisited');
    expect(body.article.summary).toBe('A short standfirst from the page itself.');
    expect(body.article.source).toBe('Example Review');
    expect(body.article.author).toBe('A. Writer');
    expect(body.article.published_at).toBe('2026-02-03T09:00:00Z');
    expect(body.article.fetch_status).toBe('ok');
    expect(body.article.word_count).toBeGreaterThan(10);
    expect(body.fetchError).toBeNull();
  });

  it('stores the normalized URL, not the pasted one', async () => {
    stubFetch(async () => htmlResponse(page()));
    const { body } = await add({ url: 'https://www.example.com/post/?utm_source=nl#top' });
    const row = await env.DB.prepare(`SELECT url, url_normalized FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(row.url).toBe('https://www.example.com/post/?utm_source=nl#top');
    expect(row.url_normalized).toBe('https://example.com/post');
  });

  it('falls back to the <title> tag and the hostname', async () => {
    stubFetch(async () => htmlResponse(page({ title: 'Just a title tag' })));
    const { body } = await add({ url: 'https://example.com/post' });
    expect(body.article.title).toBe('Just a title tag');
    expect(body.article.source).toBe('example.com');
  });

  // §3 "Show": summary falls back to the first ~40 words of extracted body.
  it('falls back to the opening words when there is no meta description', async () => {
    stubFetch(async () => htmlResponse(page()));
    const { body } = await add({ url: 'https://example.com/post' });
    expect(body.article.summary.startsWith('This paragraph is comfortably longer')).toBe(true);
  });

  it('skips navigation chrome when extracting the body', async () => {
    stubFetch(async () => htmlResponse(page()));
    const { body } = await add({ url: 'https://example.com/post' });
    const row = await env.DB.prepare(`SELECT body_text FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(row.body_text).toContain('forty character floor');
    expect(row.body_text).not.toContain('Skip this navigation');
  });

  it('writes an added event', async () => {
    stubFetch(async () => htmlResponse(page()));
    const { body } = await add({ url: 'https://example.com/post' });
    expect(await countEvents(body.article.id, 'added')).toBe(1);
  });
});

// Never a dead end. §3 "Pull"
describe('a fetch that fails still creates a usable item', () => {
  it('records the HTTP status and keeps the row', async () => {
    stubFetch(async () => new Response('nope', { status: 404 }));
    const { status, body } = await add({ url: 'https://example.com/gone' });

    expect(status).toBe(201);
    expect(body.article.fetch_status).toBe('404');
    expect(body.article.source).toBe('example.com');
    expect(body.article.title).toBe('example.com — untitled');
    expect(body.fetchError).toBe('HTTP 404');
    expect(await countEvents(body.article.id, 'added')).toBe(1);
  });

  it('flags a PDF rather than silently mangling it', async () => {
    // arXiv and friends. §9.5 -- refused cleanly, with the item still created.
    stubFetch(async () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }));
    const { status, body } = await add({ url: 'https://arxiv.org/pdf/2401.00001' });

    expect(status).toBe(201);
    expect(body.article.fetch_status).toBe('non-html');
    expect(body.article.source).toBe('arxiv.org');
    expect(body.fetchError).toContain('application/pdf');
  });

  it('survives a network error', async () => {
    stubFetch(async () => {
      throw new Error('connection reset');
    });
    const { status, body } = await add({ url: 'https://unreachable.example/post' });

    expect(status).toBe(201);
    expect(body.article.fetch_status).toBe('failed');
    expect(body.fetchError).toContain('connection reset');
  });

  it('leaves the failed item on Today so it can be dealt with', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }));
    const { body } = await add({ url: 'https://example.com/gone' });
    expect(body.article.status).toBe('new');
  });
});

describe('adding pasted text', () => {
  it('takes the first line as the title and summarizes the rest', async () => {
    const spy = stubFetch(async () => htmlResponse(page()));
    const { status, body } = await add({
      text: 'Behind A Paywall\nThe body of the piece, pasted by hand because the fetch was refused.'
    });

    expect(status).toBe(201);
    expect(body.article.title).toBe('Behind A Paywall');
    expect(body.article.source).toBe('pasted');
    expect(body.article.fetch_status).toBe('pasted');
    // The title line counts too -- word_count is over the whole pasted text.
    expect(body.article.word_count).toBe(16);
    expect(body.article.summary).toContain('pasted by hand');
    // §3: pasted text is never fetched.
    expect(spy).not.toHaveBeenCalled();
  });

  it('honours a manually supplied title and source', async () => {
    const { body } = await add({ text: 'Some body text.', title: 'My title', source: 'The Paper' });
    expect(body.article.title).toBe('My title');
    expect(body.article.source).toBe('The Paper');
  });

  it('accepts text pasted alongside a URL without fetching', async () => {
    const spy = stubFetch(async () => htmlResponse(page()));
    const { body } = await add({ url: 'https://example.com/paywalled', text: 'Pasted body text here.' });
    expect(body.article.fetch_status).toBe('pasted');
    expect(body.article.source).toBe('example.com');
    expect(spy).not.toHaveBeenCalled();
  });

  it('makes pasted text findable in the archive', async () => {
    const { body } = await add({ text: 'Title\nA piece about ferroelectric memory devices.' });
    await callJson(`/api/articles/${body.article.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ status: 'kept' })
    });
    const feed = await callJson('/api/feed?q=ferroelectric');
    expect(feed.body.archive.map((a) => a.id)).toEqual([body.article.id]);
  });
});

describe('duplicate detection', () => {
  it('returns 409 with the existing article rather than a second row', async () => {
    stubFetch(async () => htmlResponse(page({ meta: '<meta property="og:title" content="The original">' })));
    const first = await add({ url: 'https://example.com/post' });
    expect(first.status).toBe(201);

    const second = await add({ url: 'https://example.com/post' });
    expect(second.status).toBe(409);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.article.id).toBe(first.body.article.id);
    expect(second.body.article.title).toBe('The original');

    const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM article`).first();
    expect(n).toBe(1);
  });

  it('catches the same article shared with different tracking parameters', async () => {
    stubFetch(async () => htmlResponse(page()));
    const first = await add({ url: 'http://www.example.com/post/' });
    const second = await add({ url: 'https://example.com/post?utm_source=twitter' });
    expect(second.status).toBe(409);
    expect(second.body.article.id).toBe(first.body.article.id);
  });

  it('does not treat two different articles as duplicates', async () => {
    stubFetch(async () => htmlResponse(page()));
    expect((await add({ url: 'https://example.com/a' })).status).toBe(201);
    expect((await add({ url: 'https://example.com/b' })).status).toBe(201);
  });
});

describe('rejected input', () => {
  it('400s an empty payload', async () => {
    const { status, body } = await add({});
    expect(status).toBe(400);
    expect(body.error).toBe('Paste a URL or some text.');
  });

  it('400s something that is not a web address', async () => {
    const { status, body } = await add({ url: 'not a url' });
    expect(status).toBe(400);
    expect(body.error).toBe('That does not look like a web address.');
  });

  it('400s a non-http scheme', async () => {
    expect((await add({ url: 'javascript:alert(1)' })).status).toBe(400);
  });
});

// Capture greedily at ingest, process lazily forever after; the bulky half
// goes to R2, never into D1. §5.2 / §5.3
describe('raw HTML capture', () => {
  it('stores the raw page in R2 and records the key', async () => {
    await env.RAW.delete('_usage');
    stubFetch(async () => htmlResponse(page()));
    const { body } = await add({ url: 'https://example.com/post' });

    const row = await env.DB.prepare(`SELECT raw_html_key FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(row.raw_html_key).toMatch(/^raw\//);

    const object = await env.RAW.get(row.raw_html_key);
    expect(await object.text()).toContain('forty character floor');
  });

  it('skips the R2 put for a page over the per-file cap, keeping the article', async () => {
    // Padding goes in a <script>, which the extractor skips, so the raw HTML
    // is over the cap while body_text stays a normal size.
    const huge = page().replace('</body>', '<script>/*' + 'x'.repeat(2 * 1024 * 1024) + '*/</script></body>');
    expect(huge.length).toBeGreaterThan(2 * 1024 * 1024);
    stubFetch(async () => htmlResponse(huge));

    const { status, body } = await add({ url: 'https://example.com/enormous' });
    expect(status).toBe(201);
    expect(body.article.fetch_status).toBe('ok');

    const row = await env.DB.prepare(`SELECT raw_html_key FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(row.raw_html_key).toBeNull();
  });

  it('still creates the article when R2 is unavailable', async () => {
    stubFetch(async () => htmlResponse(page()));
    const broken = { ...env, RAW: { head: async () => { throw new Error('down'); },
                                    put: async () => { throw new Error('down'); } } };
    const request = new Request('https://neatinfo.test/api/articles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/r2-down' })
    });
    const { default: worker } = await import('../worker/index.js');
    const { issueCookie } = await import('../worker/auth.js');
    request.headers.set('cookie', (await issueCookie(env)).split(';')[0]);

    const res = await worker.fetch(request, broken);
    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.article.title).toBeTruthy();
  });
});
