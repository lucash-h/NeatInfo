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

// The passphrase can come from the environment or from a gitignored .env
// beside package.json, because typing it on every run is how it ends up in
// shell history. .env is deliberately separate from .dev.vars: that file holds
// the *local* secrets wrangler dev loads, and the production passphrase is a
// different value that must not leak into a dev server.
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
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so a passphrase with spaces works.
    if (value.length > 1 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

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

The passphrase is read from NEATINFO_PASSPHRASE or from app/.env
(gitignored), never from a flag.`);
    return;
  }

  const file = arg(args, '--file');
  if (!file) throw new Error('--file is required. See --help.');

  // .env is read before anything else needs it, so --base, NEATINFO_BASE and
  // the default are resolved in one place: an explicit flag wins over the
  // file, which wins over localhost.
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fromFile = await loadDotEnv(appDir);

  const base = (arg(args, '--base') || fromFile.NEATINFO_BASE || DEFAULT_BASE).replace(/\/+$/, '');
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

  // An explicit environment variable wins, so a one-off run against a
  // different instance does not need the file edited.
  const passphrase = globalThis.process.env.NEATINFO_PASSPHRASE || fromFile.NEATINFO_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      'No passphrase. Put NEATINFO_PASSPHRASE=... in app/.env (gitignored), or set it in the environment.'
    );
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
        const patch = { tags: [c.via] };
        // Some hosts (openai.com among them) answer a plain fetch with a 403,
        // so the item arrives with no text and a "<host> - untitled" title.
        // The feed that found it already knew the title, and a row you cannot
        // identify is one you will never go back to -- so supply it, but only
        // when extraction failed. A successful fetch keeps the page's own
        // title, which is canonical; a feed's is often editorialised.
        if (payload.fetchError && c.title) patch.title = c.title;
        await fetch(`${base}/api/articles/${payload.article.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(patch)
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
