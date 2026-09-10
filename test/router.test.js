// Success criterion 5: no well-formed request to any route reaches the
// catch-all 500. The router is small enough to enumerate exhaustively.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, resetDb, call, callJson, seedArticle } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);

const ALLOWED = [200, 201, 400, 401, 404, 405, 409];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

describe('router', () => {
  it('answers every route x method pair with an expected status', async () => {
    const { id } = await seedArticle();

    const paths = [
      '/api/session',
      '/api/feed',
      '/api/articles',
      `/api/articles/${id}`,
      `/api/articles/${id}/open`,
      `/api/articles/${id}/listen`,
      `/api/articles/${id}/resolve`,
      `/api/articles/${id}/star`,
      `/api/articles/${id}/refetch`,
      '/api/articles/999999',
      '/api/articles/999999/open',
      '/api/articles/999999/resolve',
      '/api/articles/999999/refetch',
      '/api/articles/not-a-number',
      `/api/articles/${id}/bogus-action`,
      '/api/settings',
      '/api/export',
      '/api/no-such-endpoint'
    ];

    const unexpected = [];
    for (const path of paths) {
      for (const method of METHODS) {
        const init = { method };
        if (method !== 'GET' && method !== 'DELETE') init.body = '{}';
        const res = await call(path, init);
        if (!ALLOWED.includes(res.status)) {
          unexpected.push(`${method} ${path} -> ${res.status} ${await res.text()}`);
        }
      }
    }

    expect(unexpected).toEqual([]);
  });

  it('404s an unknown endpoint rather than falling through to the assets handler', async () => {
    const { status, body } = await callJson('/api/no-such-endpoint');
    expect(status).toBe(404);
    expect(body.error).toBe('No such endpoint.');
  });

  it('405s an unsupported method on a known article route', async () => {
    const { id } = await seedArticle();
    const { status, body } = await callJson(`/api/articles/${id}/open`, { method: 'PUT', body: '{}' });
    expect(status).toBe(405);
    expect(body.error).toBe('Method not allowed.');
  });

  it('404s an action that is not one of open/listen/resolve/star/refetch', async () => {
    const { id } = await seedArticle();
    expect((await call(`/api/articles/${id}/publish`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('404s a non-numeric article id', async () => {
    expect((await call('/api/articles/abc')).status).toBe(404);
  });

  it('404s a missing article on every action', async () => {
    for (const action of ['open', 'listen', 'star']) {
      const { status } = await callJson(`/api/articles/999999/${action}`, { method: 'POST', body: '{}' });
      expect(status, action).toBe(404);
    }
    expect((await call('/api/articles/999999')).status).toBe(404);
    expect((await call('/api/articles/999999', { method: 'PATCH', body: '{}' })).status).toBe(404);
  });

  it('400s rather than 500s on a body it cannot use', async () => {
    const { id } = await seedArticle();
    expect((await call('/api/articles', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await call(`/api/articles/${id}/resolve`, { method: 'POST', body: JSON.stringify({ status: 'maybe' }) })).status).toBe(400);
    expect((await call('/api/settings', { method: 'PUT', body: JSON.stringify({ lapseWindowDays: 0 }) })).status).toBe(400);
    expect((await call('/api/settings', { method: 'PUT', body: JSON.stringify({ lapseWindowDays: 'soon' }) })).status).toBe(400);
  });

  it('tolerates malformed JSON without a 500', async () => {
    const { id } = await seedArticle();
    expect((await call('/api/articles', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await call(`/api/articles/${id}`, { method: 'PATCH', body: 'not json' })).status).toBe(200);
    expect((await call('/api/session', { method: 'POST', body: 'not json' }, { authed: false })).status).toBe(401);
  });
});

describe('settings', () => {
  it('reads the default lapse window', async () => {
    const { status, body } = await callJson('/api/settings');
    expect(status).toBe(200);
    expect(body.lapseWindowDays).toBe(14);
  });

  it('writes and reads back a new lapse window', async () => {
    const put = await callJson('/api/settings', { method: 'PUT', body: JSON.stringify({ lapseWindowDays: 21 }) });
    expect(put.status).toBe(200);
    expect(put.body.lapseWindowDays).toBe(21);
    expect((await callJson('/api/settings')).body.lapseWindowDays).toBe(21);
  });

  it('refuses a window outside 1-365 days', async () => {
    expect((await call('/api/settings', { method: 'PUT', body: JSON.stringify({ lapseWindowDays: 400 }) })).status).toBe(400);
  });
});

describe('export', () => {
  // Losing the archive deletes the project's entire value. §3 "Store"
  it('dumps articles, events and tags as a downloadable JSON file', async () => {
    const { id } = await seedArticle({ title: 'Exported' });
    await call(`/api/articles/${id}/star`, { method: 'POST', body: JSON.stringify({ favorite: true }) });

    const res = await call('/api/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const dump = await res.json();
    expect(dump.schema_version).toBe(1);
    expect(dump.articles.map((a) => a.title)).toContain('Exported');
    expect(dump.events.some((e) => e.type === 'starred')).toBe(true);
    expect(Array.isArray(dump.article_tags)).toBe(true);
  });
});
