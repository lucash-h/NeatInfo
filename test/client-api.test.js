// The client half of "the app must never merely look broken" (§9.1, success
// criterion 11). `src/api.js` is plain JS with no DOM in it, so it runs in the
// same workerd pool as the worker tests -- the React pieces above it
// (ErrorBoundary, the toast path in AppContext) are not covered here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, onUnauthorized } from '../src/api.js';

afterEach(() => vi.unstubAllGlobals());

function stubResponse(status, body, { throws = null } = {}) {
  const spy = vi.fn(async () => {
    if (throws) throw throws;
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('api()', () => {
  it('returns the payload and the status on success', async () => {
    stubResponse(200, { today: [] });
    const data = await api('/api/feed');
    expect(data.status).toBe(200);
    expect(data.today).toEqual([]);
  });

  it('sends the session cookie and a JSON content type only when there is a body', async () => {
    const spy = stubResponse(200, {});
    await api('/api/feed');
    expect(spy.mock.calls[0][1].credentials).toBe('same-origin');
    expect(spy.mock.calls[0][1].headers).toEqual({});

    await api('/api/articles', { method: 'POST', body: '{}' });
    expect(spy.mock.calls[1][1].headers['content-type']).toBe('application/json');
  });

  it('notifies the unauthorized handler and throws on a 401', async () => {
    stubResponse(401, { error: 'Not signed in.' });
    const seen = vi.fn();
    const unsubscribe = onUnauthorized(seen);

    await expect(api('/api/feed')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    await expect(api('/api/feed')).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('throws the server message on a 500', async () => {
    stubResponse(500, { error: 'no such column: nope' });
    await expect(api('/api/feed')).rejects.toMatchObject({
      status: 500,
      message: 'no such column: nope'
    });
  });

  it('falls back to a readable message when the body is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>502</html>', { status: 502 }));
    await expect(api('/api/feed')).rejects.toMatchObject({
      status: 502,
      message: 'Something went wrong (HTTP 502).'
    });
  });

  it('turns a network failure into an ApiError rather than a raw TypeError', async () => {
    stubResponse(0, null, { throws: new TypeError('Failed to fetch') });
    const err = await api('/api/feed').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/connection/i);
  });

  it('treats 409 as an answer, not a failure -- AddSheet needs the payload', async () => {
    stubResponse(409, { duplicate: true, article: { id: 7, title: 'Already here' } });
    const data = await api('/api/articles', { method: 'POST', body: '{}' });
    expect(data.status).toBe(409);
    expect(data.article.id).toBe(7);
  });
});
