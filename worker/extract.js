// Article extraction on Workers. HTMLRewriter is the native streaming parser here;
// Node readability libraries do not run on this runtime. §7.6

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

export function summarizeText(text) {
  const trimmed = text.trim();
  const firstBreak = trimmed.indexOf('\n');
  const rest = firstBreak === -1 ? trimmed : trimmed.slice(firstBreak + 1);
  return firstWords(rest || trimmed, 40);
}

export function countWords(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}
