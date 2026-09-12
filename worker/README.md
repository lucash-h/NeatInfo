# worker/

The Cloudflare Worker: the API, and the server for the built frontend. One
deploy, one origin, no cross-origin dance between Pages and an API.

| File | What it holds |
|---|---|
| `index.js` | Router, the three surfaces, ingest, transitions, export, candidates, pipeline, audio |
| `auth.js` | One passphrase, one HMAC-signed cookie |
| `extract.js` | HTMLRewriter extraction, entity decoding, the arXiv slice, body truncation |
| `url.js` | URL normalization for duplicate detection |
| `search.js` | FTS5 query sanitising and the archive filter SQL |
| `speech.js` | Tier 2 speech: segmenting text, calling MeloTTS |
| `importer.js` | Rebuilds a database from an export payload — pure, no I/O |

## The constraint that shapes everything here

**The free plan allows 10 ms of CPU per invocation**, and 50 subrequests. That
is not a performance target, it is a correctness boundary, and it has bitten
this project twice:

- A base64 decode loop over a 4 MB audio segment measured ~14 ms and would have
  failed *every* request in production. `wrangler dev` does not enforce CPU
  limits, so it passed locally and in an end-to-end check. `speech.js` uses a
  native decode now, and says why.
- Anything that loops over whole articles — feature extraction, chunking —
  does not belong here at all. That is why `pipeline/` runs in GitHub Actions.

I/O does not count against CPU; JavaScript does. When in doubt, measure against
a deployed request, not a local one.

## Things that look odd and are deliberate

**Surfaces are computed at read time**, from `status`, `added_at` and `origin`.
The browser sends its own local midnight as `dayStart`, so "Today" is correct
in any timezone with no timezone stored server-side and no scheduled job to
fail overnight. Today and Pending are exact complements: every undecided
article is on exactly one of them.

**Lapse is written lazily, not by a cron.** `applyLapses()` runs on every feed
read and records the transition the first time a read notices an item has aged
out. Batched at 50 rows, because a month away or a restored archive is not five
rows and nothing promises D1 will accept an arbitrarily large batch.

**`BIND_CHUNK = 90`.** D1 refuses a statement with more than 100 bound
variables, which turned a 200-row archive page into a 500. Any `IN (...)` over
a page of rows is chunked.

**R2 usage lives in a D1 `setting` row**, not in an R2 object. The previous
version was an R2 read-modify-write, so two concurrent adds lost one of the
counts and a deletion never subtracted. `/api/settings` re-measures the bucket
authoritatively, because only a walk of it can see a deletion.

**A failed fetch still creates the article.** Login walls, PDFs and dead hosts
produce a row with the URL, a `fetch_status`, and a prompt to paste the text.
Never a dead end (§3).

**Nothing reads the `event` table to drive behaviour.** It is written from day
one because V2 cannot reconstruct it; `/api/export` copies it wholesale, which
is a backup rather than logic.

## Two auth schemes, on purpose

- **A session cookie** for everything a person does — one passphrase, HMAC
  signed, 90 days.
- **`x-discover-key`** for the machine-facing routes: `/api/candidates` and
  `/api/pipeline/*`. One credential for GitHub Actions, kept separate from the
  passphrase so a pipeline key cannot read the archive as you.

## Tests

`../test/` runs inside workerd via `@cloudflare/vitest-pool-workers`, so
HTMLRewriter, D1 and R2 behave as they do in production. See `../test/README.md`
for the two things that surprise people.
