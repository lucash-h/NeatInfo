# scripts/

Four standalone Node scripts. None of them is part of the deployed Worker, none
needs a dependency installed, and none runs on Cloudflare — they are the things
you run *at* a NeatInfo, not *inside* one.

| Script | What it does |
|---|---|
| `gather-candidates.mjs` | Collects candidate article URLs from TLDR AI, Hacker News and Hugging Face daily papers |
| `seed-articles.mjs` | Adds a candidate list to a running NeatInfo through its own API |
| `import.mjs` | Turns a `GET /api/export` payload back into SQL, for restoring a database |
| `validate-capture.mjs` | Checks that captured raw HTML has the shape v2 will need (§5.4) |

---

## Populating the board

The design report's §9.1 names the real risk to v1: the Today page is empty
every day until you feed it, and if the habit does not hold for two weeks the
app dies of an empty page rather than of a bug. These two scripts are the
cheapest answer that is not yet automation — fill the board once, from sources
that have already done the selecting.

### 1. Gather

```bash
node scripts/gather-candidates.mjs --out candidates.json
```

Writes a JSON array of `{url, via, title}`. It adds nothing to NeatInfo; look at
the file before you seed from it.

Three sources, chosen because each arrives with a filter already attached
(§7.1: fetching candidates is easy — *selecting* is the whole problem, and a
firehose without a scorer just relocates the triage work):

- **TLDR AI** — borrowed human curation (§7.3). Someone competent read 200
  things and picked ten. Editorial links are told apart from sponsored ones by
  `utm_source=tldrai`; the sponsors use `utm_source=tldr`, a
  `links.tldrnewsletter.com` redirect, or an ad network. The headline is taken
  from the anchor text, since these pages are the likeliest to refuse a fetch.
- **Hacker News** — via the free Algolia index, no key. Points are a real
  external signal, so it takes the top N rather than everything. Several
  queries, because a single "AI" search misses the tooling and paper stories
  that never use the word.
- **Hugging Face daily papers** — a voted view over arXiv, which is closer to
  "trending papers" than a raw category feed. Entries are arXiv ids, and the
  worker already extracts `/abs/` pages, so this source needs no special
  handling downstream.

Options:

```
--out <path>        where to write the list (required)
--hn-points <n>     minimum Hacker News points        (default 100)
--days <n>          how far back to look on HN        (default 14)
--hn <n>            max Hacker News candidates        (default 25)
--tldr <n>          max TLDR AI candidates            (default 25)
--papers <n>        max Hugging Face paper candidates (default 15)
--allow-social      keep x.com / reddit / mastodon links (dropped by default,
                    because they produce items with no text that need
                    hand-finishing)
```

A source that returns nothing prints a warning rather than passing quietly.
§9.6 is explicit that this kind of parser fails *silently* — the shapes above
will change without notice, and a quiet zero looks exactly like a slow news
day. If a source warns, read its page and fix the selector.

### 2. Seed

```bash
node scripts/seed-articles.mjs --file candidates.json --limit 5    # look first
node scripts/seed-articles.mjs --file candidates.json             # then the rest
```

Adds each candidate with `POST /api/articles` — **not** a direct D1 insert. That
is the point: extraction, the arXiv slice, URL normalization, duplicate
detection, the body cap and raw HTML capture all behave exactly as they do when
you paste a link by hand, so a bulk load cannot produce rows the app could not
have produced itself. Re-running over the same file is safe; the duplicate
guard answers 409 and the script counts it as `already present`.

Each item is added with `origin: 'auto'`, so it waits in **Pending** and never
lands on Today — fifty links dumped onto Today would destroy the one property
that page has. Each is also tagged with its source (`hackernews`, `tldr-ai`,
`hf-daily-papers`), which makes provenance a filter in the archive and, later,
lets you compare keep-rate per source (§7.5).

**Credentials.** The passphrase is read from `NEATINFO_PASSPHRASE`, or from a
gitignored `app/.env` — never from a flag, because a flag lands in shell
history and in the process list. Copy `.env.example`:

```
NEATINFO_PASSPHRASE=the-passphrase-you-type-into-the-app
NEATINFO_BASE=https://neatinfo.<subdomain>.workers.dev
```

`.env` is deliberately **not** `.dev.vars`. That file holds the local secrets
`wrangler dev` loads; the production passphrase is a different value and must
not leak into a dev server. An explicit environment variable still beats the
file, and `--base` still beats `NEATINFO_BASE`.

Options:

```
--file <path>    candidate list from gather-candidates.mjs (required)
--base <url>     NeatInfo origin        (default http://localhost:8787)
--limit <n>      stop after n additions (default: all)
--delay <ms>     pause between adds     (default 1500)
--dry-run        list what would be added, add nothing
```

**On the output.** `needs text` is not a failure. Some hosts answer a plain
fetch with a 403 (openai.com does), so the item arrives with a URL, a title
from the feed, and no body. It is in the app with a retry button and a paste
box — §3's "never a dead end". `failed` is a real failure and worth reading.

### Why this is a bootstrap, not the pipeline

These scripts are an *external client*: they sign in over HTTP and need a
passphrase, a machine that is awake, and a round trip per article. The
recurring version belongs inside the Worker as a Cron Trigger, on the
authenticated side of the boundary, writing to D1 directly — no passphrase, no
`.env`, nothing running on your laptop. `POST /api/articles` already accepts
`defer: true` to insert a row without fetching the page, which is what keeps a
scheduled run inside the free plan's 50-subrequest and 10 ms CPU ceilings.

The scripts keep a real job after that exists: one-off backfills, seeding a
fresh database, and trying a new source before committing it to a cron.

---

## Restoring a database

```bash
node scripts/import.mjs --file neatinfo-2026-09-11.json --out restore.sql
npx wrangler d1 execute neatinfo --remote --file=restore.sql
```

Turns a `GET /api/export` payload into SQL. The statement building itself lives
in `worker/importer.js` so that the same code is exercised by the test suite
against a real D1 inside workerd, rather than only by this script — the round
trip is asserted row-for-row in `test/export.test.js`.

The target database must already have the schema applied and its tables empty;
this does not truncate anything. It restores D1 only: `raw_html_keys` in the
payload is a manifest of what the archive expects to find in R2, not the blobs
themselves, so a bucket loss is not recoverable from an export. Article and
event ids are preserved, tags resolve by name, and inserting fires the FTS
triggers so the restored archive is searchable rather than merely present.

`--force` is required to overwrite an existing `--out` file.

---

## Checking the raw capture

```bash
node scripts/validate-capture.mjs
```

§5.4's ten-minute check: walks the export, pulls raw HTML back through
`GET /api/articles/:id/raw`, and reports outbound-link counts, numeric density
and clean-chunk sizes — the shape v2's scorer needs. It answers "is the thing
we are hoarding actually usable", which is worth knowing before a year of
hoarding.
