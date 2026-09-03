// One passphrase in an env var, one signed cookie. A single-user tool has no
// multi-tenant problem for an auth vendor to solve. (Stack brainstorm, §"you
// probably don't need auth at all")

const COOKIE = 'neatinfo_session';
const TTL_SECONDS = 60 * 60 * 24 * 90;
const encoder = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(secret, payload) {
  const sig = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

// Constant-time-ish compare so a wrong guess leaks no timing signal.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueCookie(env) {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = await sign(env.SESSION_SECRET, String(expires));
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_SECONDS}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function isAuthed(request, env) {
  if (!env.PASSPHRASE || !env.SESSION_SECRET) return false;

  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\s*)${COOKIE}=([^;]+)`));
  if (!match) return false;

  const token = match[1];
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;

  const expires = token.slice(0, dot);
  if (!/^\d+$/.test(expires) || Number(expires) < Math.floor(Date.now() / 1000)) return false;

  const expected = await sign(env.SESSION_SECRET, expires);
  return safeEqual(expected, token);
}

export function checkPassphrase(env, given) {
  return Boolean(env.PASSPHRASE) && safeEqual(env.PASSPHRASE, String(given ?? ''));
}
