// One passphrase, one signed cookie. The regression that matters here is G1:
// the session cookie was only found in first position, so any cookie set ahead
// of it (Cloudflare's own `__cf_bm`, for one) logged you out.
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { isAuthed } from '../worker/auth.js';
import { applySchema, call, callJson, sessionCookie } from './helpers.js';

beforeAll(applySchema);

const encoder = new TextEncoder();

// Mirrors worker/auth.js's signing so a test can forge a *validly signed but
// expired* token -- otherwise "expired" and "tampered" are the same test.
async function signToken(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  let s = '';
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  const b64url = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${payload}.${b64url}`;
}

const request = (cookie) =>
  new Request('https://neatinfo.test/api/feed', { headers: cookie ? { cookie } : {} });

describe('isAuthed cookie parsing', () => {
  it('accepts the session cookie in first position', async () => {
    const cookie = await sessionCookie();
    expect(await isAuthed(request(cookie), env)).toBe(true);
  });

  // G1 regression. `(?:^|;\s*)` in a template literal compiles to `(?:^|;s*)`.
  it('accepts the session cookie when another cookie precedes it', async () => {
    const cookie = await sessionCookie();
    expect(await isAuthed(request(`__cf_bm=abc123; ${cookie}`), env)).toBe(true);
  });

  it('accepts it in the middle of a longer cookie header', async () => {
    const cookie = await sessionCookie();
    expect(await isAuthed(request(`__cf_bm=abc; ${cookie}; cf_clearance=zzz`), env)).toBe(true);
  });

  it('is not fooled by a cookie whose name merely ends with ours', async () => {
    const cookie = await sessionCookie();
    expect(await isAuthed(request(`not_neatinfo_session=${cookie.split('=')[1]}`), env)).toBe(false);
  });

  it('rejects a missing cookie header', async () => {
    expect(await isAuthed(request(), env)).toBe(false);
    expect(await isAuthed(request('__cf_bm=abc'), env)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const cookie = await sessionCookie();
    const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
    expect(await isAuthed(request(`__cf_bm=abc; ${tampered}`), env)).toBe(false);
  });

  it('rejects a validly signed but expired token', async () => {
    const past = String(Math.floor(Date.now() / 1000) - 60);
    const token = await signToken(env.SESSION_SECRET, past);
    expect(await isAuthed(request(`neatinfo_session=${token}`), env)).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const token = await signToken('some-other-secret', future);
    expect(await isAuthed(request(`neatinfo_session=${token}`), env)).toBe(false);
  });

  it('rejects a token with no signature at all', async () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    expect(await isAuthed(request(`neatinfo_session=${future}`), env)).toBe(false);
  });
});

describe('/api/session', () => {
  it('signs in with the right passphrase and sets an HttpOnly cookie', async () => {
    const { res, body } = await callJson(
      '/api/session',
      { method: 'POST', body: JSON.stringify({ passphrase: env.PASSPHRASE }) },
      { authed: false }
    );
    expect(res.status).toBe(200);
    expect(body.authed).toBe(true);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('neatinfo_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('refuses the wrong passphrase', async () => {
    const { status, body } = await callJson(
      '/api/session',
      { method: 'POST', body: JSON.stringify({ passphrase: 'not it' }) },
      { authed: false }
    );
    expect(status).toBe(401);
    expect(body.error).toBeTruthy();
  });

  it('refuses a missing passphrase', async () => {
    const { status } = await callJson('/api/session', { method: 'POST', body: '{}' }, { authed: false });
    expect(status).toBe(401);
  });

  it('reports authed:false with no cookie and true with one', async () => {
    const anon = await callJson('/api/session', { method: 'GET' }, { authed: false });
    expect(anon.body.authed).toBe(false);

    const signedIn = await callJson('/api/session', { method: 'GET' });
    expect(signedIn.body.authed).toBe(true);
  });

  it('signs out by expiring the cookie', async () => {
    const res = await call('/api/session', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects an unsupported method on the session route', async () => {
    expect((await call('/api/session', { method: 'PUT' }, { authed: false })).status).toBe(405);
  });
});

describe('authentication gate', () => {
  const protectedRoutes = [
    ['GET', '/api/feed'],
    ['POST', '/api/articles'],
    ['GET', '/api/articles/1'],
    ['PATCH', '/api/articles/1'],
    ['POST', '/api/articles/1/open'],
    ['POST', '/api/articles/1/listen'],
    ['POST', '/api/articles/1/resolve'],
    ['POST', '/api/articles/1/star'],
    ['GET', '/api/settings'],
    ['PUT', '/api/settings'],
    ['GET', '/api/export'],
    ['GET', '/api/does-not-exist']
  ];

  it.each(protectedRoutes)('%s %s returns 401 when signed out', async (method, path) => {
    const init = { method };
    if (method !== 'GET') init.body = '{}';
    const { status, body } = await callJson(path, init, { authed: false });
    expect(status).toBe(401);
    expect(body.error).toBe('Not signed in.');
  });
});
