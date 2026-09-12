// Repairs articles stored before V1-30, when extraction wrote HTML entities
// straight through: titles read `Ed Zitron&#39;s`, bodies read `people&#8217;s
// heads`. New articles are clean; these are the ones already in the database.
//
//   node scripts/repair-entities.mjs                 # dry run, changes nothing
//   node scripts/repair-entities.mjs --apply         # write the repairs
//
// Reads NEATINFO_PASSPHRASE / NEATINFO_BASE the same way seed-articles.mjs
// does: environment first, then a gitignored app/.env.
//
// Two repair routes, because the two halves of the problem are not alike:
//
//   Body text  -> refetch. The extractor is fixed, so re-running it produces a
//                 clean row. PATCHing body_text would work but sets
//                 fetch_status='pasted', which would relabel two dozen fetched
//                 articles as hand-pasted and quietly corrupt the one signal
//                 that says where text came from.
//   Title and  -> decode locally and PATCH. Needed for pages that no longer
//   summary       fetch (openai.com answers 403), where refetch cannot help.
//
// A refetch that fails leaves the stored row untouched, so the fallback is
// always safe to attempt afterwards.

import { decodeEntities } from '../worker/extract.js';

const DEFAULT_BASE = 'http://localhost:8787';

// Matches the entities the decoder handles. Deliberately the same shape, so
// "needs repair" and "can be repaired" cannot drift apart.
const ENTITY = /&(?:lt|gt|quot|apos|nbsp|amp|#\d+|#[xX][0-9a-fA-F]+);/;

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

function affected(article) {
  const fields = [];
  if (ENTITY.test(article.title || '')) fields.push('title');
  if (ENTITY.test(article.summary || '')) fields.push('summary');
  if (ENTITY.test(article.body_text || '')) fields.push('body');
  return fields;
}

async function main() {
  const args = globalThis.process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/repair-entities.mjs [--apply] [--base <url>] [--delay <ms>]

Finds articles whose stored text still contains HTML entities and repairs them.
Dry run unless --apply is given; a dry run lists every change it would make.

  --apply        write the repairs (default: report only)
  --base <url>   NeatInfo origin (default .env NEATINFO_BASE, else ${DEFAULT_BASE})
  --delay <ms>   pause between repairs, since each may refetch a page (default 1000)`);
    return;
  }

  const apply = args.includes('--apply');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fromFile = await loadDotEnv(appDir);

  const flagBase = args.indexOf('--base') === -1 ? null : args[args.indexOf('--base') + 1];
  const base = (flagBase || fromFile.NEATINFO_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const delayIdx = args.indexOf('--delay');
  const delay = Number(delayIdx === -1 ? 1000 : args[delayIdx + 1]);

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

  // The feed carries every undecided row; the archive is paged, so both are
  // walked. A repair that silently skipped the archive would look complete.
  const seen = new Map();
  const feed = await (await fetch(`${base}/api/feed?limit=200`, { headers: { cookie } })).json();
  for (const row of [...feed.today, ...feed.pending, ...feed.archive]) seen.set(row.id, row);

  let offset = feed.archive.length;
  while (offset < (feed.archiveTotal || 0)) {
    const page = await (await fetch(`${base}/api/feed?limit=200&offset=${offset}`, { headers: { cookie } })).json();
    if (!page.archive?.length) break;
    for (const row of page.archive) seen.set(row.id, row);
    offset += page.archive.length;
  }

  console.log(`${seen.size} article(s) to inspect at ${base}.${apply ? '' : '  (dry run)'}\n`);

  const todo = [];
  for (const id of seen.keys()) {
    const { article } = await (await fetch(`${base}/api/articles/${id}`, { headers: { cookie } })).json();
    const fields = affected(article);
    if (fields.length) todo.push({ article, fields });
  }

  if (!todo.length) {
    console.log('Nothing to repair.');
    return;
  }

  console.log(`${todo.length} article(s) affected:\n`);
  for (const { article, fields } of todo) {
    console.log(`  #${article.id} [${fields.join(', ')}] ${decodeEntities(article.title || '').slice(0, 60)}`);
  }

  if (!apply) {
    console.log(`\nDry run -- nothing written. Re-run with --apply to repair.`);
    return;
  }

  console.log('\nRepairing...\n');
  const tally = { refetched: 0, patched: 0, failed: 0 };

  for (const [i, { article, fields }] of todo.entries()) {
    const label = `${String(i + 1).padStart(3)}/${todo.length} #${article.id}`;
    let bodyFixed = !fields.includes('body');

    // Route 1: re-extract. Fixes every field at once, and correctly, because
    // it is the real extractor running over the real page.
    if (fields.includes('body') && article.url) {
      try {
        const res = await fetch(`${base}/api/articles/${article.id}/refetch`, { method: 'POST', headers: { cookie } });
        const payload = await res.json().catch(() => ({}));
        if (res.ok && !payload.fetchError) {
          bodyFixed = true;
          tally.refetched += 1;
          console.log(`${label} refetched`);
        } else {
          console.log(`${label} refetch failed (${payload.fetchError || res.status}) -- falling back`);
        }
      } catch (err) {
        console.log(`${label} refetch error (${err.message}) -- falling back`);
      }
    }

    // Route 2: decode what is stored. Always safe, but cannot reach body_text
    // without relabelling the article as pasted, so the body is left for a
    // future refetch rather than corrupted now.
    const patch = {};
    const freshTitle = decodeEntities(article.title || '');
    const freshSummary = decodeEntities(article.summary || '');
    if (fields.includes('title') && freshTitle !== article.title) patch.title = freshTitle;
    if (fields.includes('summary') && freshSummary !== article.summary) patch.summary = freshSummary;

    if (Object.keys(patch).length) {
      const res = await fetch(`${base}/api/articles/${article.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(patch)
      });
      if (res.ok) {
        tally.patched += 1;
        console.log(`${label} patched ${Object.keys(patch).join(', ')}`);
      } else {
        tally.failed += 1;
        console.log(`${label} PATCH FAILED HTTP ${res.status}`);
      }
    }

    if (!bodyFixed) {
      console.log(`${label} body still escaped -- the page could not be refetched`);
    }

    if (i < todo.length - 1) await sleep(delay);
  }

  console.log(`\nRefetched ${tally.refetched}, patched ${tally.patched}, failed ${tally.failed}.`);
}

await main().catch((err) => {
  console.error(String(err.message || err));
  globalThis.process.exitCode = 1;
});
