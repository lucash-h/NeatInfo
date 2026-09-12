// Rebuilds article.url_normalized from article.url.
//
//   node scripts/renormalize-urls.mjs                    # report only
//   node scripts/renormalize-urls.mjs --out renorm.sql   # write the SQL
//   npx wrangler d1 execute neatinfo --remote --file=renorm.sql
//
// url_normalized is derived data: the raw url is always stored beside it, so
// the key can be rebuilt whenever the rules change. That property is what
// makes the normalizer a *choice* rather than a constraint -- add a strip
// rule, rewrite discover/ in another language, change your mind about trailing
// slashes, then run this and the column catches up.
//
// It is also the deduplication key. The UNIQUE index on
// (topic_id, url_normalized) is the only thing that decides whether two links
// are the same article, so this script's real job is not the recompute -- that
// is one line -- but refusing to produce SQL that would violate it.
//
// **Collisions are the whole point.** If two articles recompute to the same
// key, the new rules say they are the same article and the database says they
// are two rows. That is a merge, not an update: one is kept and one dismissed,
// both may have notes, each has its own events (which V2 trains on and cannot
// reconstruct) and possibly its own R2 capture. No script should guess. This
// one reports them and writes nothing for those rows.

import { normalizeUrl } from '../worker/url.js';

const DEFAULT_BASE = 'http://localhost:8787';

async function loadDotEnv(dir) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let text;
  try {
    text = await readFile(join(dir, '.env'), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length > 1 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

const sqlLiteral = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function main() {
  const args = globalThis.process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/renormalize-urls.mjs [--out <file.sql>] [--base <url>]

Recomputes article.url_normalized from article.url and reports what would
change. Writes SQL only when --out is given, and never for rows whose new key
would collide with another article's.

  --out <path>   write UPDATE statements here
  --base <url>   NeatInfo origin (default .env NEATINFO_BASE, else ${DEFAULT_BASE})`);
    return;
  }

  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const env = await loadDotEnv(appDir);

  const flagBase = args.indexOf('--base') === -1 ? null : args[args.indexOf('--base') + 1];
  const base = (flagBase || env.NEATINFO_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const out = args.indexOf('--out') === -1 ? null : args[args.indexOf('--out') + 1];

  const passphrase = globalThis.process.env.NEATINFO_PASSPHRASE || env.NEATINFO_PASSPHRASE;
  if (!passphrase) throw new Error('No passphrase. Set NEATINFO_PASSPHRASE, or put it in app/.env.');

  const auth = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase })
  });
  if (!auth.ok) throw new Error(`Sign-in failed against ${base}: HTTP ${auth.status}.`);
  const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];

  const payload = await (await fetch(`${base}/api/export`, { headers: { cookie } })).json();
  const articles = payload.articles || [];

  // What the key would be under today's rules.
  const planned = new Map();      // id -> new key
  const byKey = new Map();        // new key -> [ids]
  let unchanged = 0;
  let noUrl = 0;

  for (const a of articles) {
    if (!a.url) { noUrl += 1; continue; }
    const next = normalizeUrl(a.url) || a.url;
    if (next === a.url_normalized) { unchanged += 1; continue; }
    planned.set(a.id, { from: a.url_normalized, to: next, title: a.title });
    if (!byKey.has(next)) byKey.set(next, []);
    byKey.get(next).push(a.id);
  }

  // A new key colliding with a row that is NOT changing is just as much a
  // collision as two changed rows colliding with each other.
  const existingKeys = new Map();
  for (const a of articles) {
    if (!a.url_normalized) continue;
    if (planned.has(a.id)) continue;
    existingKeys.set(a.url_normalized, a.id);
  }

  const safe = [];
  const collisions = [];
  for (const [id, change] of planned) {
    const sharesWithChanged = (byKey.get(change.to) || []).length > 1;
    const sharesWithStable = existingKeys.has(change.to);
    if (sharesWithChanged || sharesWithStable) {
      collisions.push({ id, ...change, against: sharesWithStable ? existingKeys.get(change.to) : byKey.get(change.to).filter((x) => x !== id) });
    } else {
      safe.push({ id, ...change });
    }
  }

  console.log(`${articles.length} article(s): ${unchanged} already correct, ${noUrl} with no url, ${planned.size} would change.\n`);

  for (const c of safe.slice(0, 20)) {
    console.log(`  #${c.id} ${String(c.title || '').slice(0, 44)}`);
    console.log(`      from ${c.from}`);
    console.log(`      to   ${c.to}`);
  }
  if (safe.length > 20) console.log(`  ... and ${safe.length - 20} more`);

  if (collisions.length) {
    console.log(`\n${collisions.length} row(s) would collide and are NOT included:`);
    for (const c of collisions) {
      console.log(`  #${c.id} -> ${c.to}`);
      console.log(`      already claimed by article ${JSON.stringify(c.against)}`);
    }
    console.log('\nThese are duplicates under the new rules. Merging them is a judgement:');
    console.log('which status wins, what happens to both sets of notes, and where the');
    console.log('events point afterwards. Decide per row; this script will not guess.');
  }

  if (!out) {
    console.log(`\nReport only. Pass --out <file.sql> to write ${safe.length} UPDATE statement(s).`);
    return;
  }

  if (!safe.length) {
    console.log('\nNothing safe to write.');
    return;
  }

  const lines = safe.map(
    (c) => `UPDATE article SET url_normalized = ${sqlLiteral(c.to)} WHERE id = ${c.id};`
  );
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, lines.join('\n') + '\n', 'utf8');
  console.log(`\nWrote ${out}: ${lines.length} statement(s).`);
  console.log(`Apply with: npx wrangler d1 execute neatinfo --remote --file=${out}`);
}

const argv = globalThis.process?.argv;
if (argv && typeof argv[1] === 'string' && argv[1].replace(/\\/g, '/').endsWith('scripts/renormalize-urls.mjs')) {
  await main().catch((err) => {
    console.error(String(err.message || err));
    globalThis.process.exitCode = 1;
  });
}
