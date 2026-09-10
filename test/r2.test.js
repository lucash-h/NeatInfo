// §5.2 -- what R2 is holding, and what an add costs.
//
// The counter used to be an R2 object rewritten on every add (a `head` for the
// budget check, then another `head` and a `put` to bump it), which lost counts
// whenever two adds overlapped and could never subtract a deleted object. It
// is now a D1 row that ingest increments and a walk of the bucket corrects.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, callJson, resetDb, seedArticle } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PARAGRAPH =
  'This paragraph is comfortably longer than the forty character floor the body extractor uses to ignore page chrome.';

const page = (body = PARAGRAPH) =>
  `<!doctype html><html><head><title>A page</title></head><body><article><p>${body}</p></article></body></html>`;

const htmlResponse = (html) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

const add = (url) =>
  callJson('/api/articles', { method: 'POST', body: JSON.stringify({ url }) });

// The bucket is shared across test files, so every assertion here is about a
// number this test computed itself rather than a constant.
async function bucketBytes() {
  let bytes = 0;
  let cursor;
  do {
    const listed = await env.RAW.list({ limit: 1000, cursor });
    for (const object of listed.objects) bytes += object.size;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return bytes;
}

async function usageSetting() {
  const row = await env.DB.prepare(`SELECT value FROM setting WHERE key = 'r2_usage_bytes'`).first();
  return row ? Number(row.value) : null;
}

describe('R2 operations per add', () => {
  it('performs exactly one R2 operation -- the put', async () => {
    // Warm the cached figure first, so the one-off first-run measurement is
    // not charged to the add being measured.
    await callJson('/api/settings');

    const put = vi.spyOn(env.RAW, 'put');
    const head = vi.spyOn(env.RAW, 'head');
    const list = vi.spyOn(env.RAW, 'list');
    const get = vi.spyOn(env.RAW, 'get');

    vi.stubGlobal('fetch', async () => htmlResponse(page()));
    const { status } = await add('https://example.com/one-op');
    expect(status).toBe(201);

    expect(put).toHaveBeenCalledTimes(1);
    expect(head).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('never writes a _usage object', async () => {
    vi.stubGlobal('fetch', async () => htmlResponse(page()));
    await add('https://example.com/no-usage-object');
    expect(await env.RAW.head('_usage')).toBeNull();
  });
});

describe('the usage counter', () => {
  it('grows by the size of the captured HTML', async () => {
    const html = page('x '.repeat(400));
    vi.stubGlobal('fetch', async () => htmlResponse(html));

    // Warmed first: an unset counter measures the whole bucket on the way in,
    // which would show up as growth that this add did not cause.
    await callJson('/api/settings');
    const before = await usageSetting();
    const { body } = await add('https://example.com/counted');
    const after = await usageSetting();

    expect(after - before).toBe(new TextEncoder().encode(html).byteLength);

    const row = await env.DB.prepare(`SELECT raw_html_key FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(row.raw_html_key).toMatch(/^raw\//);
  });

  it('does not move when the page is over the per-object cap', async () => {
    const huge = page().replace('</body>', '<script>/*' + 'x'.repeat(2 * 1024 * 1024) + '*/</script></body>');
    vi.stubGlobal('fetch', async () => htmlResponse(huge));

    await callJson('/api/settings');
    const before = await usageSetting();
    const { status } = await add('https://example.com/too-big');
    expect(status).toBe(201);
    expect(await usageSetting()).toBe(before);
  });

  it('refuses the capture when the measured bucket is over budget, and still keeps the article', async () => {
    // A cached figure at the ceiling forces the exact re-measurement; the
    // stubbed list reports a bucket that really is full.
    await env.DB.prepare(
      `INSERT INTO setting (key, value) VALUES ('r2_usage_bytes', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(String(9 * 1024 * 1024 * 1024)).run();

    const list = vi.spyOn(env.RAW, 'list').mockResolvedValue({
      objects: [{ key: 'raw/pretend.html', size: 9 * 1024 * 1024 * 1024 }],
      truncated: false
    });
    const put = vi.spyOn(env.RAW, 'put');

    vi.stubGlobal('fetch', async () => htmlResponse(page()));
    const { status, body } = await add('https://example.com/over-budget');

    expect(status).toBe(201);
    expect(body.article.fetch_status).toBe('ok');
    expect(put).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalled();

    const row = await env.DB.prepare(`SELECT raw_html_key FROM article WHERE id = ?1`)
      .bind(body.article.id).first();
    expect(row.raw_html_key).toBeNull();
  });
});

describe('GET /api/settings', () => {
  it('reports the sum of what is actually in the bucket', async () => {
    vi.stubGlobal('fetch', async () => htmlResponse(page()));
    await add('https://example.com/measured');

    const { body } = await callJson('/api/settings');
    expect(body.r2UsageBytes).toBe(await bucketBytes());
    expect(body.r2BudgetMb).toBe(8 * 1024);
  });

  it('subtracts an object that was deleted, which the old counter never did', async () => {
    vi.stubGlobal('fetch', async () => htmlResponse(page('y '.repeat(300))));
    const { body } = await add('https://example.com/deleted-later');
    const row = await env.DB.prepare(`SELECT raw_html_key FROM article WHERE id = ?1`)
      .bind(body.article.id).first();

    const before = (await callJson('/api/settings')).body.r2UsageBytes;
    await env.RAW.delete(row.raw_html_key);
    const after = (await callJson('/api/settings')).body.r2UsageBytes;

    expect(after).toBeLessThan(before);
    expect(after).toBe(await bucketBytes());
    // The cached figure the ingest path reads was corrected by the same walk.
    expect(await usageSetting()).toBe(after);
  });

  it('answers with a null usage figure rather than failing when R2 is absent', async () => {
    const { default: worker } = await import('../worker/index.js');
    const { issueCookie } = await import('../worker/auth.js');
    const request = new Request('https://neatinfo.test/api/settings', {
      headers: { cookie: (await issueCookie(env)).split(';')[0] }
    });
    const res = await worker.fetch(request, { ...env, RAW: undefined });
    expect(res.status).toBe(200);
    expect((await res.json()).r2UsageMb).toBeNull();
  });
});

describe('a bucket walk longer than one page', () => {
  it('follows the cursor rather than stopping at the first page', async () => {
    let calls = 0;
    vi.spyOn(env.RAW, 'list').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { objects: [{ key: 'a', size: 10 }], truncated: true, cursor: 'c1' };
      return { objects: [{ key: 'b', size: 5 }], truncated: false };
    });

    await seedArticle({ status: 'kept' });
    const { body } = await callJson('/api/settings');
    expect(body.r2UsageBytes).toBe(15);
    expect(calls).toBe(2);
  });
});
