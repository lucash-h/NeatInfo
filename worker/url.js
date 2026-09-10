// Duplicate detection works on a normalized URL, not the raw one. §3 "Pull"
const STRIP_PARAMS = [
  /^utm_/i, /^ref$/i, /^ref_src$/i, /^source$/i, /^fbclid$/i, /^gclid$/i,
  /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hs(enc|mi)$/i, /^si$/i
];

// §9.5 -- "arXiv PDFs remain unhandled", and a large share of primary AI
// research is exactly that. The PDF itself is not extractable on this runtime
// (no WASM parser, no Browser Rendering), but the /abs/ page beside it is
// plain HTML carrying the title, the authors, the date and the whole abstract.
// So the two link shapes are one paper: /pdf/<id> normalizes to /abs/<id>,
// which also means pasting the PDF link after the abstract link is caught by
// the duplicate guard instead of creating a second item. §3 "Pull"
//
// Ids come in both the modern (2401.12345v2) and the legacy (math.GT/0309136)
// shapes, so the id is whatever follows the segment rather than a pattern.
const ARXIV_HOSTS = /^(www\.|export\.|browse\.)?arxiv\.org$/;
const ARXIV_PATH = /^\/(abs|pdf)\/(.+?)(\.pdf)?$/;

export function arxivAbsPath(hostname, pathname) {
  if (!ARXIV_HOSTS.test(hostname)) return null;
  const match = pathname.match(ARXIV_PATH);
  if (!match) return null;
  return '/abs/' + match[2];
}

// True for a URL normalizeUrl has already pointed at an abstract page.
export function isArxivAbs(raw) {
  try {
    const u = new URL(raw);
    return Boolean(arxivAbsPath(u.hostname, u.pathname));
  } catch {
    return false;
  }
}

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

  const arxiv = arxivAbsPath(u.hostname, u.pathname);
  if (arxiv) {
    u.hostname = 'arxiv.org';
    u.pathname = arxiv;
    // `?context=cs.LG` and friends are navigation state, not the paper.
    u.search = '';
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
