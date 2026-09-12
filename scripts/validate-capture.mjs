// §5.4 -- "run a throwaway script over the ~35 articles you've collected and
// check you can actually extract what §8 wants (specificity counts, outbound
// links, clean chunkable text). Ten minutes to validate a year of assumptions."
//
// This is that script. It walks the export, pulls each article's raw HTML back
// through GET /api/articles/:id/raw, and prints one row per article plus a
// verdict, so the failure mode §5.4 warns about -- the capture turning out to
// have the wrong *shape* a year later -- is visible in ten minutes instead.
//
// Usage (nothing to install; Node 18+):
//
//   NEATINFO_URL=https://neatinfo.raaaaaaaaaaaa.workers.dev \
//   NEATINFO_PASSPHRASE='...' node scripts/validate-capture.mjs
//
//   node scripts/validate-capture.mjs --file neatinfo-2026-09-10.json
//     analyses an export on disk; raw HTML is only fetched when a URL and a
//     passphrase are also given.
//
// The analysis half is exported so it can be tested; nothing here is imported
// by the Worker.

const TAG = /<[^>]+>/g;
const SCRIPTISH = /<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ANCHOR = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
const BLOCK = /<(p|li|h[1-6]|blockquote|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;

function decode(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function hostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// §8 stage 1's structural signals, measured over the raw page rather than the
// extracted text, because that is where they live:
//   - outbound links: does the page cite anything, and how much of it leaves
//     the site (a paper linking arXiv and GitHub looks very different from a
//     roundup linking only itself);
//   - numeric density: the cheapest proxy for "has actual results in it";
//   - clean chunks: whether the capture can be split into embedding-sized
//     pieces at all, which is what stage 3 needs.
export function analyzeRaw(html, pageUrl = null) {
  const cleaned = String(html || '').replace(SCRIPTISH, ' ');
  const selfHost = pageUrl ? hostOf(pageUrl) : null;

  let links = 0;
  let outbound = 0;
  const hosts = new Set();
  for (const [, href] of cleaned.matchAll(ANCHOR)) {
    if (/^(#|mailto:|javascript:)/i.test(href)) continue;
    links += 1;
    const host = hostOf(href);
    if (host && host !== selfHost) {
      outbound += 1;
      hosts.add(host);
    }
  }

  const chunks = [];
  for (const [, , inner] of cleaned.matchAll(BLOCK)) {
    const text = decode(inner.replace(TAG, ' ')).replace(/\s+/g, ' ').trim();
    // The same forty-character floor worker/extract.js uses to ignore chrome.
    if (text.length > 40) chunks.push(text);
  }

  const words = chunks.join(' ').split(/\s+/).filter(Boolean);
  const numeric = words.filter((w) => /\d/.test(w)).length;
  const chunkWords = chunks.map((c) => c.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);

  return {
    bytes: new TextEncoder().encode(String(html || '')).byteLength,
    links,
    outbound,
    outboundHosts: hosts.size,
    words: words.length,
    // Share of tokens containing a digit. Low single digits is prose; a paper
    // with tables runs far higher.
    numericDensity: words.length ? numeric / words.length : 0,
    chunks: chunks.length,
    medianChunkWords: chunkWords.length ? chunkWords[Math.floor(chunkWords.length / 2)] : 0,
    maxChunkWords: chunkWords.length ? chunkWords[chunkWords.length - 1] : 0
  };
}

// The verdict §5.4 actually asks for: is this capture usable by §8, or is it a
// nav-bar and a cookie banner?
export function verdict(a) {
  if (!a.bytes) return 'no raw copy';
  if (a.chunks < 3 || a.words < 150) return 'THIN — check the capture';
  if (!a.outbound) return 'usable, no outbound links';
  return 'usable';
}

export function formatTable(rows) {
  const header = ['id', 'source', 'words', 'chunks', 'med', 'out', 'num%', 'verdict', 'title'];
  const body = rows.map((r) => [
    String(r.id),
    (r.source || '').slice(0, 18),
    String(r.words),
    String(r.chunks),
    String(r.medianChunkWords),
    String(r.outbound),
    (r.numericDensity * 100).toFixed(1),
    r.verdict,
    (r.title || '').slice(0, 40)
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();

  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

// ------------------------------------------------------------------- CLI

async function main() {
  const { readFile } = await import('node:fs/promises');
  const args = globalThis.process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };

  const base = (arg('--url') || globalThis.process.env.NEATINFO_URL || '').replace(/\/$/, '');
  const passphrase = arg('--passphrase') || globalThis.process.env.NEATINFO_PASSPHRASE || '';
  const file = arg('--file');

  let cookie = null;
  if (base && passphrase) {
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase })
    });
    if (!res.ok) throw new Error(`Sign-in failed: HTTP ${res.status}`);
    cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  }

  let payload;
  if (file) {
    payload = JSON.parse(await readFile(file, 'utf8'));
  } else {
    if (!cookie) throw new Error('Give --file, or NEATINFO_URL plus NEATINFO_PASSPHRASE.');
    const res = await fetch(`${base}/api/export`, { headers: { cookie } });
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
    payload = await res.json();
  }

  const articles = payload.articles || [];
  const withRaw = articles.filter((a) => a.raw_html_key);
  const rows = [];

  for (const article of withRaw) {
    let html = '';
    if (cookie && base) {
      const res = await fetch(`${base}/api/articles/${article.id}/raw`, { headers: { cookie } });
      if (res.ok) html = await res.text();
      else console.error(`  ! article ${article.id}: raw fetch returned HTTP ${res.status}`);
    }
    const analysis = analyzeRaw(html, article.url);
    rows.push({ id: article.id, title: article.title, source: article.source, ...analysis, verdict: verdict(analysis) });
  }

  console.log(`${articles.length} articles exported, ${withRaw.length} with a raw copy in R2.\n`);
  if (!rows.length) {
    console.log('Nothing to analyse. Add a few articles by URL first. §5.4');
    return;
  }

  console.log(formatTable(rows));

  // "no raw copy" here means the object was recorded but could not be read
  // back, which is exactly the §5.4 failure being looked for.
  const thin = rows.filter((r) => r.verdict.startsWith('THIN') || r.verdict === 'no raw copy').length;
  const noLinks = rows.filter((r) => r.outbound === 0).length;
  const density = rows.reduce((sum, r) => sum + r.numericDensity, 0) / rows.length;

  console.log(`
Verdict (§5.4): ${rows.length - thin}/${rows.length} captures are chunkable.
  thin or empty captures : ${thin}${thin ? '  <- look at these before trusting the archive for §8' : ''}
  captures with no outbound links : ${noLinks}
  mean numeric density : ${(density * 100).toFixed(1)}%`);
}

// Run as a CLI only when Node executed this file directly. The analysis
// functions above are imported by the test suite, which runs in workerd, so
// nothing from node: may be imported at the top level.
const argv = globalThis.process?.argv;
if (argv && typeof argv[1] === 'string' && argv[1].replace(/\\/g, '/').endsWith('scripts/validate-capture.mjs')) {
  await main().catch((err) => {
    console.error(String(err.message || err));
    globalThis.process.exitCode = 1;
  });
}
