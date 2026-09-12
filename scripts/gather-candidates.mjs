// Collects candidate article URLs from the three sources that come with a
// filter already attached (§7.1: fetching candidates is easy, selecting is the
// whole problem -- so prefer a source that has already selected).
//
//   TLDR AI      someone competent read 200 things and picked ~10. §7.3
//   Hacker News  points are a real external popularity signal. §7.2
//   HF papers    the "trending papers" list, which is arXiv ids. §7.2
//
// Writes a JSON array of {url, via, title} to --out. It does NOT add anything
// to NeatInfo; scripts/seed-articles.mjs does that, through the real ingest
// path, so extraction, duplicate detection and raw capture all behave exactly
// as they do when you paste a link by hand.
//
//   node scripts/gather-candidates.mjs --out candidates.json
//   node scripts/gather-candidates.mjs --out candidates.json --hn-points 150 --days 7
//
// Nothing here needs a key, and none of it runs on Cloudflare -- this is a
// local prototype of the poll step in §7.4.

const UA = 'NeatInfo/1.0 (personal reading tracker; single user)';

function arg(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------- Hacker News
//
// Algolia's HN index is free and needs no key. Several queries rather than one:
// a single "AI" query misses the paper-and-tooling stories that never use the
// word, and each query is cheap.

const HN_QUERIES = ['AI', 'LLM', 'machine learning', 'OpenAI', 'Anthropic', 'neural network'];

async function fromHackerNews({ points, days, limit }) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const out = new Map();

  for (const query of HN_QUERIES) {
    const url = `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(query)}`
      + `&numericFilters=points>${points},created_at_i>${since}&hitsPerPage=50`;
    let data;
    try {
      data = await getJson(url);
    } catch (err) {
      console.error(`  hn: "${query}" failed -- ${err.message}`);
      continue;
    }
    for (const hit of data.hits || []) {
      // An Ask HN or a text post has no url of its own. The discussion is not
      // the article, so skip rather than storing a link to comments.
      if (!hit.url) continue;
      if (!out.has(hit.url)) {
        out.set(hit.url, { url: hit.url, via: 'hackernews', title: hit.title || '', points: hit.points || 0 });
      }
    }
  }

  // Points are the whole reason this source is worth using: take the top, not
  // everything. §7.5
  return [...out.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

// ------------------------------------------------------------------- TLDR AI
//
// The editorial links carry ?utm_source=tldrai; the sponsored ones use
// utm_source=tldr, a links.tldrnewsletter.com redirect, or an ad network. That
// distinction is the filter -- and it is exactly the kind of thing §9.6 warns
// will change without warning, which is why this reports a count and
// seed-articles.mjs treats zero as an error rather than an empty day.

const TLDR_LATEST = 'https://tldr.tech/api/latest/ai';

async function fromTldrAi({ limit }) {
  const html = await getText(TLDR_LATEST);
  const out = new Map();

  for (const match of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const raw = match[1].replace(/&amp;/g, '&');
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.searchParams.get('utm_source') !== 'tldrai') continue;
    if (u.hostname.endsWith('tldr.tech')) continue;
    if (!out.has(u.toString())) out.set(u.toString(), { url: u.toString(), via: 'tldr-ai', title: '' });
  }

  return [...out.values()].slice(0, limit);
}

// -------------------------------------------------------- Hugging Face papers
//
// The daily-papers list is a curated/voted "trending" view over arXiv, which is
// closer to what you actually want than a raw category firehose. Each entry is
// an arXiv id, and V1-21 already normalizes /abs/<id> and extracts the title,
// authors, date and abstract -- so the ingest half of this source is done.

async function fromHuggingFacePapers({ limit }) {
  const data = await getJson(`https://huggingface.co/api/daily_papers?limit=${Math.max(limit, 1)}`);
  const out = [];
  for (const entry of data || []) {
    const id = entry?.paper?.id;
    if (!id) continue;
    out.push({
      url: `https://arxiv.org/abs/${id}`,
      via: 'hf-daily-papers',
      title: entry?.paper?.title?.trim() || '',
      upvotes: entry?.paper?.upvotes ?? 0
    });
  }
  return out.slice(0, limit);
}

// ------------------------------------------------------------------- assembly

// Hosts that reliably produce an item with no text: a login wall, a single
// post, or a discussion thread. §3's "never a dead end" handles them fine once
// they are in -- you get a row with a URL and a paste-the-text prompt -- but a
// bulk pre-populate is not the moment to fill the board with rows that need
// hand-finishing. Pass --allow-social to keep them.
const SOCIAL = [
  'twitter.com', 'x.com', 'mastodon.social', 'mathstodon.xyz', 'bsky.app',
  'threads.net', 'reddit.com', 'news.ycombinator.com', 'linkedin.com'
];

function isSocial(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return SOCIAL.some((s) => host === s || host.endsWith('.' + s));
  } catch {
    return false;
  }
}

// Cheap local duplicate collapse so the same story arriving from TLDR and HN is
// one candidate. This is deliberately NOT the real check: worker/url.js does
// that properly at ingest, against everything already in the archive.
function dedupeKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return host + path;
  } catch {
    return url;
  }
}

async function main() {
  const args = globalThis.process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/gather-candidates.mjs --out <candidates.json> [options]

  --out <path>        where to write the candidate list (required)
  --hn-points <n>     minimum Hacker News points        (default 100)
  --days <n>          how far back to look on HN        (default 14)
  --hn <n>            max Hacker News candidates        (default 25)
  --tldr <n>          max TLDR AI candidates            (default 25)
  --papers <n>        max Hugging Face paper candidates (default 15)
  --allow-social      keep links to x.com, reddit, mastodon etc. (off by default)`);
    return;
  }

  const out = arg(args, '--out');
  if (!out) throw new Error('--out is required. See --help.');

  const points = Number(arg(args, '--hn-points', '100'));
  const days = Number(arg(args, '--days', '14'));
  const limits = {
    hn: Number(arg(args, '--hn', '25')),
    tldr: Number(arg(args, '--tldr', '25')),
    papers: Number(arg(args, '--papers', '15'))
  };

  const sources = [
    ['hackernews', () => fromHackerNews({ points, days, limit: limits.hn })],
    ['tldr-ai', () => fromTldrAi({ limit: limits.tldr })],
    ['hf-daily-papers', () => fromHuggingFacePapers({ limit: limits.papers })]
  ];

  const all = [];
  for (const [name, run] of sources) {
    try {
      const found = await run();
      console.log(`${name}: ${found.length} candidates`);
      // §9.6's canary, in its cheapest form: a source that normally yields
      // links and suddenly yields none has broken, it has not had a quiet day.
      if (!found.length) console.error(`  WARNING: ${name} returned nothing -- check whether its shape changed.`);
      all.push(...found);
    } catch (err) {
      console.error(`${name}: FAILED -- ${err.message}`);
    }
  }

  const allowSocial = args.includes('--allow-social');
  const seen = new Set();
  const unique = [];
  let skipped = 0;
  for (const c of all) {
    if (!allowSocial && isSocial(c.url)) { skipped += 1; continue; }
    const key = dedupeKey(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  if (skipped) console.log(`
Skipped ${skipped} social/discussion link(s); --allow-social keeps them.`);

  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, JSON.stringify(unique, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${out}: ${unique.length} unique candidates (${all.length} before dedupe).`);
}

await main().catch((err) => {
  console.error(String(err.message || err));
  globalThis.process.exitCode = 1;
});
