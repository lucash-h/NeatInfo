// URL normalization for the discovery script.
// Mirrors worker/url.js logic but runs in Node.js.

const STRIP_PARAMS = [
  /^utm_/i, /^ref$/i, /^ref_src$/i, /^source$/i, /^fbclid$/i, /^gclid$/i,
  /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hs(enc|mi)$/i, /^si$/i,
];

export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.protocol = 'https:';
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');

  // arXiv /pdf/ → /abs/
  if (/^(www\.|export\.|browse\.)?arxiv\.org$/.test(u.hostname)) {
    const m = u.pathname.match(/^\/(abs|pdf)\/(.+?)(\.pdf)?$/);
    if (m) {
      u.hostname = 'arxiv.org';
      u.pathname = '/abs/' + m[2];
      u.search = '';
    }
  }

  for (const key of [...u.searchParams.keys()]) {
    if (STRIP_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  let path = u.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  u.pathname = path;

  return u.toString();
}

export function sourceFromUrl(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
