// Adds a candidate list (scripts/gather-candidates.mjs) to NeatInfo through the
// real API, one POST /api/articles at a time.
//
// Deliberately NOT a direct D1 insert. Going through the ingest path means
// extraction, the arXiv slice, URL normalization, duplicate detection, the
// body_text cap and raw HTML capture all happen exactly as they do when you
// paste a link by hand -- so a bulk pre-populate cannot produce rows that the
// app could never have produced itself.
//
//   # against a local `wrangler dev`
//   NEATINFO_PASSPHRASE='...' node scripts/seed-articles.mjs --file candidates.json
//
//   # against the deployed Worker
//   NEATINFO_PASSPHRASE='...' node scripts/seed-articles.mjs \
//     --file candidates.json --base https://neatinfo.<subdomain>.workers.dev
//
// The passphrase comes from the environment, never a flag: a flag lands in
// shell history and in the process list.
//
// Each add makes the Worker fetch the article, so this is paced. Everything it
// does is on Cloudflare's free tier -- the cost is one subrequest and one R2
// put per article.

const DEFAULT_BASE = 'http://localhost:8787';

function arg(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = globalThis.process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: NEATINFO_PASSPHRASE='...' node scripts/seed-articles.mjs --file <candidates.json> [options]

  --file <path>    candidate list from gather-candidates.mjs (required)
  --base <url>     NeatInfo origin              (default ${DEFAULT_BASE})
  --limit <n>      stop after n additions       (default: all)
  --delay <ms>     pause between additions      (default 1500)
  --dry-run        list what would be added, add nothing

The passphrase is read from NEATINFO_PASSPHRASE, never from a flag.`);
    return;
  }

  const file = arg(args, '--file');
  if (!file) throw new Error('--file is required. See --help.');

  const base = (arg(args, '--base', DEFAULT_BASE) || DEFAULT_BASE).replace(/\/+$/, '');
  const delay = Number(arg(args, '--delay', '1500'));
  const limitArg = arg(args, '--limit');
  const dryRun = args.includes('--dry-run');

  const { readFile } = await import('node:fs/promises');
  const candidates = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(candidates) || !candidates.length) {
    // §9.6: a source that yields nothing has broken, it has not had a quiet
    // day. Refuse rather than reporting a cheerful zero.
    throw new Error(`${file} holds no candidates. Re-run gather-candidates.mjs and check its warnings.`);
  }

  const list = limitArg ? candidates.slice(0, Number(limitArg)) : candidates;

  if (dryRun) {
    console.log(`Would add ${list.length} article(s) to ${base}:\n`);
    for (const c of list) console.log(`  [${c.via}] ${c.url}`);
    return;
  }

  const passphrase = globalThis.process.env.NEATINFO_PASSPHRASE;
  if (!passphrase) {
    throw new Error('NEATINFO_PASSPHRASE is not set. Export it and re-run; it is deliberately not a flag.');
  }

  // One sign-in, then the signed cookie is reused for every add.
  const auth = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase })
  });
  if (!auth.ok) {
    throw new Error(`Sign-in failed against ${base}: HTTP ${auth.status}. Wrong passphrase, or wrong --base?`);
  }
  const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Sign-in returned no cookie.');

  const tally = { added: 0, duplicate: 0, noText: 0, failed: 0 };

  for (const [i, c] of list.entries()) {
    const label = `${String(i + 1).padStart(3)}/${list.length}`;
    try {
      const res = await fetch(`${base}/api/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        // origin:'auto' lands it in Pending rather than Today. A 50-link
        // pre-populate dumped onto Today would destroy the one property that
        // page has -- that it is short enough to finish. §7.7
        body: JSON.stringify({ url: c.url, origin: 'auto' })
      });
      const payload = await res.json().catch(() => ({}));

      // Tag with where it came from. There is no "added by a machine" column
      // in the schema (§7.7 asks whether there should be), but a tag is a
      // first-class archive filter already, so provenance becomes something
      // you can actually query -- and later compare keep-rates across. §7.5
      if (res.status === 201 && payload.article?.id) {
        await fetch(`${base}/api/articles/${payload.article.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ tags: [c.via] })
        }).catch(() => {});
      }

      if (res.status === 409) {
        tally.duplicate += 1;
        console.log(`${label} dup   ${c.url}`);
      } else if (res.status === 201) {
        // A failed fetch still creates the item (§3 "never a dead end"), so
        // this is worth counting separately: those rows need text pasted in
        // before they are readable.
        if (payload.fetchError) {
          tally.noText += 1;
          console.log(`${label} text? ${payload.article?.title || c.url} -- ${payload.fetchError}`);
        } else {
          tally.added += 1;
          console.log(`${label} ok    ${payload.article?.title || c.url}`);
        }
      } else {
        tally.failed += 1;
        console.log(`${label} FAIL  HTTP ${res.status} ${payload.error || ''} -- ${c.url}`);
      }
    } catch (err) {
      tally.failed += 1;
      console.log(`${label} FAIL  ${String(err.message || err)} -- ${c.url}`);
    }

    if (i < list.length - 1) await sleep(delay);
  }

  console.log(`\nAdded ${tally.added}, needs text ${tally.noText}, already present ${tally.duplicate}, failed ${tally.failed}.`);
  if (tally.noText) {
    console.log('"needs text" items are in the app with a URL and a paste-the-text prompt -- not lost.');
  }
}

await main().catch((err) => {
  console.error(String(err.message || err));
  globalThis.process.exitCode = 1;
});
