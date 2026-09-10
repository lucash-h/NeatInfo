// Article extraction on Workers. HTMLRewriter is the native streaming parser here;
// Node readability libraries do not run on this runtime. §7.6

import { isArxivAbs } from './url.js';

const SKIP = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'svg']);
const BLOCKS = 'article p, article li, main p, main li, [role="main"] p, [role="main"] li, body p, body li';

class Meta {
  constructor() {
    this.data = {};
  }
  element(el) {
    const prop = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
    const content = el.getAttribute('content');
    if (!prop || !content) return;
    const keep = {
      'og:title': 'title',
      'twitter:title': 'title',
      'og:description': 'summary',
      'description': 'summary',
      'twitter:description': 'summary',
      'og:site_name': 'source',
      'author': 'author',
      'article:author': 'author',
      'article:published_time': 'published_at',
      'datepublished': 'published_at'
    }[prop];
    if (keep && !this.data[keep]) this.data[keep] = content.trim();
  }
}

class Title {
  constructor(target) {
    this.target = target;
    this.buf = '';
  }
  text(chunk) {
    this.buf += chunk.text;
    if (chunk.lastInTextNode && !this.target.data.title) {
      this.target.data.title = this.buf.trim();
    }
  }
}

// Collects visible block-level text, skipping chrome. Not a full readability
// port -- it is the cheap 80% that keeps the pipeline free and on-runtime.
class Body {
  constructor() {
    this.parts = [];
    this.current = '';
    this.depth = 0;
  }
  element(el) {
    if (this.depth > 0) return;
    el.onEndTag(() => {
      const text = this.current.replace(/\s+/g, ' ').trim();
      if (text.length > 40) this.parts.push(text);
      this.current = '';
    });
  }
  text(chunk) {
    if (this.depth === 0) this.current += chunk.text;
  }
}

class Skipper {
  constructor(body) {
    this.body = body;
  }
  element(el) {
    this.body.depth += 1;
    el.onEndTag(() => {
      this.body.depth -= 1;
    });
  }
}

function firstWords(text, n) {
  const words = text.split(/\s+/).filter(Boolean).slice(0, n);
  if (!words.length) return '';
  return words.join(' ') + (text.split(/\s+/).length > n ? '…' : '');
}

// ------------------------------------------------------------------ arXiv
//
// §9.5: papers are not an edge case here, and the generic extractor refuses a
// PDF rather than mangling it. The narrow slice: the /abs/ page carries the
// title, the authors, the date and the whole abstract as ordinary HTML, and
// worker/url.js already points both link shapes at it. The abstract becomes
// the body text -- it is what the paper claims, which is what triage needs.
// Full PDF text extraction stays out of v1 (decision D1); AddSheet's
// paste-the-text fallback is still there for when the abstract is not enough.

class ArxivMeta {
  constructor() {
    this.title = '';
    this.authors = [];
    this.date = null;
    this.abstract = '';
  }
  element(el) {
    const name = (el.getAttribute('name') || '').toLowerCase();
    const content = el.getAttribute('content');
    if (!content) return;
    if (name === 'citation_title' && !this.title) this.title = content.trim();
    else if (name === 'citation_author') this.authors.push(content.trim());
    else if ((name === 'citation_date' || name === 'citation_online_date') && !this.date) this.date = content.trim();
    else if (name === 'citation_abstract' && !this.abstract) this.abstract = content.trim();
  }
}

class Collect {
  constructor() {
    this.buf = '';
  }
  text(chunk) {
    this.buf += chunk.text;
  }
  get value() {
    return this.buf.replace(/\s+/g, ' ').trim();
  }
}

// arXiv prefixes the visible blocks with a descriptor span: "Abstract: ...",
// "Title:...". Stripping it is cosmetic but it is what ends up in the summary.
function stripDescriptor(text) {
  return text.replace(/^(abstract|title|authors|subjects)\s*:\s*/i, '').trim();
}

// citation_date is `2024/01/16`; the schema stores ISO strings.
function arxivDate(raw) {
  if (!raw) return null;
  const parts = raw.split(/[/-]/).map((p) => p.trim());
  if (parts.length < 3) return null;
  const [y, m, d] = parts;
  if (!/^\d{4}$/.test(y)) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Returns the extracted paper, or null when the page did not look like an
// abstract page after all -- in which case the caller falls back to the
// generic extractor rather than storing an empty item.
export async function extractArxiv(html) {
  const meta = new ArxivMeta();
  const abstract = new Collect();
  const title = new Collect();
  const authors = new Collect();

  await new HTMLRewriter()
    .on('meta', meta)
    .on('blockquote.abstract', abstract)
    .on('h1.title', title)
    .on('div.authors', authors)
    .transform(new Response(html))
    .text();

  const paperTitle = meta.title || stripDescriptor(title.value);
  const body = meta.abstract || stripDescriptor(abstract.value);
  if (!paperTitle || !body) return null;

  // The author column is one TEXT field, and a long-collaboration paper can
  // list hundreds.
  const names = meta.authors.length
    ? meta.authors
    : stripDescriptor(authors.value).split(/,\s*/).filter(Boolean);
  const author = names.length > 8 ? names.slice(0, 8).join(', ') + ' et al.' : names.join(', ');

  return {
    ok: true,
    fetch_status: 'ok',
    html,
    title: paperTitle,
    summary: firstWords(body, 40),
    source: 'arXiv',
    author: author || null,
    published_at: arxivDate(meta.date),
    body_text: body,
    word_count: countWords(body)
  };
}

export async function extractArticle(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; NeatInfo/1.0; +personal archive)',
        accept: 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      cf: { cacheTtl: 0 }
    });
  } catch (err) {
    return { ok: false, fetch_status: 'failed', error: String(err && err.message || err) };
  }

  if (!res.ok) {
    return { ok: false, fetch_status: String(res.status), error: `HTTP ${res.status}` };
  }

  const type = res.headers.get('content-type') || '';
  if (!type.includes('html')) {
    // arXiv PDFs and friends. §9.5 -- flagged rather than silently mangled.
    return { ok: false, fetch_status: 'non-html', error: `Cannot extract ${type.split(';')[0] || 'this content type'} yet` };
  }

  const html = await res.text();

  // §9.5's narrow slice. The abstract page is the only non-generic path in
  // here; everything else, arXiv listing pages included, falls through.
  if (isArxivAbs(url)) {
    const paper = await extractArxiv(html);
    if (paper) return paper;
  }

  const meta = new Meta();
  const body = new Body();
  const rewriter = new HTMLRewriter()
    .on('meta', meta)
    .on('title', new Title(meta))
    .on([...SKIP].join(','), new Skipper(body))
    .on(BLOCKS, body);

  await rewriter.transform(new Response(html)).text();

  const bodyText = body.parts.join('\n\n');
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

  // v1 summaries are meta descriptions, falling back to the opening words.
  // No LLM call, no API key. §3 "Show"
  const summary = meta.data.summary || firstWords(bodyText, 40);

  return {
    ok: true,
    fetch_status: 'ok',
    html,
    title: meta.data.title || '',
    summary,
    source: meta.data.source || '',
    author: meta.data.author || null,
    published_at: meta.data.published_at || null,
    body_text: bodyText || null,
    word_count: wordCount
  };
}

// D1 refuses any single value over roughly 1 MB with
// `D1_ERROR: string or blob too big: SQLITE_TOOBIG`, so a long page used to
// 500 at INSERT and the article was lost outright -- exactly the dead end §3
// "Pull" forbids. The cap is half that ceiling: ~85,000 words, some seventeen
// times the 5,000-word article §5.1 sizes the archive around, with enough
// headroom that multibyte text and the marker below cannot push a value over
// the limit. Nothing is truly lost -- the raw HTML is already in R2. §5.2
export const BODY_TEXT_LIMIT = 512 * 1024;

export const TRUNCATION_MARK =
  '\n\n[NeatInfo kept the first 512 KB of this page. The full copy is in R2. §5.2]';

// Returns the text to store and whether it had to be cut, so the caller can
// say so rather than silently keeping half an article.
export function truncateBodyText(text, limit = BODY_TEXT_LIMIT) {
  if (!text) return { text: text ?? null, truncated: false };

  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= limit) return { text, truncated: false };

  const room = limit - encoder.encode(TRUNCATION_MARK).byteLength;
  // A byte slice can land inside a multi-byte character; the decoder turns the
  // stub into U+FFFD, which is then trimmed off.
  let cut = new TextDecoder().decode(bytes.subarray(0, room)).replace(/\uFFFD+$/, '');

  // Prefer a paragraph break, then a word break, so the text does not stop
  // mid-word. Both are only accepted near the end of what was kept.
  const floor = Math.floor(cut.length * 0.9);
  const paragraph = cut.lastIndexOf('\n\n');
  const word = cut.lastIndexOf(' ');
  const at = paragraph > floor ? paragraph : word > floor ? word : cut.length;

  return { text: cut.slice(0, at).trimEnd() + TRUNCATION_MARK, truncated: true };
}

export function summarizeText(text) {
  const trimmed = text.trim();
  const firstBreak = trimmed.indexOf('\n');
  const rest = firstBreak === -1 ? trimmed : trimmed.slice(firstBreak + 1);
  return firstWords(rest || trimmed, 40);
}

export function countWords(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}
