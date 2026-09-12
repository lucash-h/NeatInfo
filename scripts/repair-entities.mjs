// Repairs articles stored before V1-30, when extraction wrote HTML entities
// straight through: titles read `Ed Zitron&#39;s`, bodies read `people&#8217;s
// heads`. New articles are clean; these are the ones already in the database.
//
//   node scripts/repair-entities.mjs                 # dry run, changes nothing
//   node scripts/repair-entities.mjs --apply         # decode in place
//   node scripts/repair-entities.mjs --apply --refetch   # and re-extract, see below
//
// Reads NEATINFO_PASSPHRASE / NEATINFO_BASE the same way seed-articles.mjs
// does: environment first, then a gitignored app/.env.
//
// **The repair is a pure local transform.** Every field is decoded from what is
// already stored and PATCHed back. It needs no network beyond this API, cannot
// fail halfway through a page load, works for articles whose source now 403s,
// and produces a known-correct result. `keep_fetch_status: true` is sent with
// the body so decoding cannot relabel a fetched article as hand-pasted.
//
// An earlier version repaired bodies by calling refetch, reasoning that the
// extractor was fixed so re-running it would produce a clean row. That is true
// and it is not free: refetch overwrites title, source, summary, body and the
// raw capture with whatever the URL serves *now* -- a paywall interstitial, a
// consent wall, a CMS re-render -- and on failure it rewrites `fetch_status`,
// so an article that is currently 'ok' and now 403s is permanently relabelled
// as failed. A repair should not be able to lose anything.
//
// --refetch keeps that upside as a separate, opt-in second pass, aimed only at
// rows where re-extraction is the point rather than a side effect: no body, no
// raw capture, or no author. Those are the cases a local decode genuinely
// cannot reach. Export first (`GET /api/export`); it is worth the thirty
// seconds before any pass that rewrites rows.

import { decodeEntities } from '../worker/extract.js';

const DEFAULT_BASE = 'http://localhost:8787';

// Any named entity, not only the ones the decoder knows. A row containing
// `&frobnicate;` should be *reported* even though nothing will repair it --
// the alternative is a blind spot that matches the decoder's own, where an
// unhandled entity is not merely unrepaired but not even counted.
const ANY_ENTITY = /&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/;

const FIELDS = ['title', 'summary', 'source', 'author', 'body_text'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// What is escaped, and what a decode would actually change. A field can
// contain an entity the decoder does not handle, in which case it is reported
// as unrepairable rather than silently counted as fixed.
function inspect(article) {
  const escaped = [];
  const repairable = {};
  const stubborn = [];

  for (const field of FIELDS) {
    const value = article[field];
    if (typeof value !== 'string' || !ANY_ENTITY.test(value)) continue;
    escaped.push(field);
    const decoded = decodeEntities(value);
    if (decoded !== value) repairable[field] = decoded;
    if (ANY_ENTITY.test(decoded)) stubborn.push(field);
  }
  return { escaped, repairable, stubborn };
}

function wantsRefetch(article) {
  const reasons = [];
  if (!article.body_text) reasons.push('no body');
  if (!article.author) reasons.push('no author');
  return reasons;
}

async function main() {
  const args = globalThis.process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/repair-entities.mjs [--apply] [--refetch] [--base <url>] [--delay <ms>]

Decodes HTML entities in stored articles. Dry run unless --apply is given.

  --apply        write the repairs (default: report only)
  --refetch      additionally re-extract rows that a local decode cannot fix
                 (no body, no author). Overwrites those rows from the live
                 page, so it is opt-in and runs after the decode pass.
  --base <url>   NeatInfo origin (default .env NEATINFO_BASE, else ${DEFAULT_BASE})
  --delay <ms>   pause between writes (default 250; 1000 with --refetch)`);
    return;
  }

  const apply = args.includes('--apply');
  const refetch = args.includes('--refetch');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fromFile = await loadDotEnv(appDir);

  const flagBase = args.indexOf('--base') === -1 ? null : args[args.indexOf('--base') + 1];
  const base = (flagBase || fromFile.NEATINFO_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const delayIdx = args.indexOf('--delay');
  const delay = Number(delayIdx === -1 ? (refetch ? 1000 : 250) : args[delayIdx + 1]);

  const passphrase = globalThis.process.env.NEATINFO_PASSPHRASE || fromFile.NEATINFO_PASSPHRASE;
  if (!passphrase) {
    throw new Error('No passphrase. Put NEATINFO_PASSPHRASE=... in app/.env, or set it in the environment.');
  }

  const auth = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase })
  });
  if (!auth.ok) throw new Error(`Sign-in failed against ${base}: HTTP ${auth.status}.`);
  const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];

  // The feed carries Today and Pending whole; the archive is paged, so it is
  // walked. A repair that quietly skipped the archive would look complete.
  const ids = new Set();
  const feed = await (await fetch(`${base}/api/feed?limit=200`, { headers: { cookie } })).json();
  for (const row of [...feed.today, ...feed.pending, ...feed.archive]) ids.add(row.id);

  let offset = feed.archive.length;
  while (offset < (feed.archiveTotal || 0)) {
    const page = await (await fetch(`${base}/api/feed?limit=200&offset=${offset}`, { headers: { cookie } })).json();
    if (!page.archive?.length) break;
    for (const row of page.archive) ids.add(row.id);
    offset += page.archive.length;
  }

  console.log(`${ids.size} article(s) to inspect at ${base}.${apply ? '' : '  (dry run)'}\n`);

  const todo = [];
  for (const id of ids) {
    const { article } = await (await fetch(`${base}/api/articles/${id}`, { headers: { cookie } })).json();
    const found = inspect(article);
    if (found.escaped.length) todo.push({ article, ...found });
  }

  if (!todo.length) {
    console.log('Nothing to repair.');
    return;
  }

  console.log(`${todo.length} article(s) affected:\n`);
  for (const { article, escaped, stubborn } of todo) {
    const flag = stubborn.length ? `  [unhandled entity in ${stubborn.join(', ')}]` : '';
    console.log(`  #${article.id} [${escaped.join(', ')}] ${decodeEntities(article.title || '').slice(0, 55)}${flag}`);
  }

  const unhandled = todo.filter((t) => t.stubborn.length);
  if (unhandled.length) {
    console.log(`\n${unhandled.length} row(s) contain an entity the decoder does not know.`);
    console.log('Add it to NAMED in worker/extract.js and re-run, rather than leaving it escaped.');
  }

  if (!apply) {
    console.log(`\nDry run -- nothing written. Re-run with --apply to repair.`);
    return;
  }

  console.log('\nDecoding in place...\n');
  const tally = { patched: 0, failed: 0, refetched: 0, refetchFailed: 0 };

  for (const [i, { article, repairable }] of todo.entries()) {
    const label = `${String(i + 1).padStart(3)}/${todo.length} #${article.id}`;
    const fields = Object.keys(repairable);
    if (!fields.length) {
      console.log(`${label} nothing decodable`);
      continue;
    }

    // body_text rides along with keep_fetch_status so a pure decode cannot
    // relabel the article as pasted.
    const patch = { ...repairable };
    if ('body_text' in patch) patch.keep_fetch_status = true;

    const res = await fetch(`${base}/api/articles/${article.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(patch)
    });

    if (res.ok) {
      tally.patched += 1;
      console.log(`${label} decoded ${fields.join(', ')}`);
    } else {
      tally.failed += 1;
      console.log(`${label} PATCH FAILED HTTP ${res.status}`);
    }
    if (i < todo.length - 1) await sleep(delay);
  }

  console.log(`\nDecoded ${tally.patched}, failed ${tally.failed}.`);

  if (!refetch) {
    console.log('\nRun again with --refetch to re-extract rows a decode cannot fix (no body, no author).');
    return;
  }

  // Second pass, opt-in. Re-extraction is a content refresh: its upside is
  // exactly the reason to run it, and its downside -- overwriting a row from
  // whatever the URL serves today -- is why it is not part of the repair.
  const candidates = [];
  for (const id of ids) {
    const { article } = await (await fetch(`${base}/api/articles/${id}`, { headers: { cookie } })).json();
    const reasons = wantsRefetch(article);
    if (article.url && reasons.length) candidates.push({ article, reasons });
  }

  if (!candidates.length) {
    console.log('\nNothing needs re-extraction.');
    return;
  }

  console.log(`\nRe-extracting ${candidates.length} row(s)...\n`);
  for (const [i, { article, reasons }] of candidates.entries()) {
    const label = `${String(i + 1).padStart(3)}/${candidates.length} #${article.id}`;
    try {
      const res = await fetch(`${base}/api/articles/${article.id}/refetch`, { method: 'POST', headers: { cookie } });
      const payload = await res.json().catch(() => ({}));
      if (res.ok && !payload.fetchError) {
        tally.refetched += 1;
        console.log(`${label} refetched (${reasons.join(', ')})`);
      } else {
        tally.refetchFailed += 1;
        console.log(`${label} refetch failed: ${payload.fetchError || res.status}`);
      }
    } catch (err) {
      tally.refetchFailed += 1;
      console.log(`${label} refetch error: ${err.message}`);
    }
    if (i < candidates.length - 1) await sleep(delay);
  }

  console.log(`\nRefetched ${tally.refetched}, failed ${tally.refetchFailed}.`);
  console.log('A failed refetch rewrites fetch_status on that row -- that is refetch, not the decode pass.');
}

await main().catch((err) => {
  console.error(String(err.message || err));
  globalThis.process.exitCode = 1;
});
