# NeatInfo

Implementation of `NeatInfo.dc.html` (Claude Design) against the v1 scope in
`../NeatInfo_Design_Report.md`: **pull, show, deal with, store.**

One Cloudflare Worker serves both the static frontend and the API. D1 holds the
queryable data, R2 holds raw HTML. No build step, no framework, no cron.

```
app/
  wrangler.toml        bindings + secrets checklist
  schema.sql           D1 schema, FTS5 index, seed topic
  seed.sql             sample rows for local dev only
  worker/
    index.js           router, surfaces, transitions, export
    extract.js         HTMLRewriter extraction + meta-description summaries
    auth.js            single passphrase, HMAC-signed cookie
    url.js             URL normalization for duplicate detection
  public/
    index.html         shell
    styles.css         tokens lifted from the design canvas
    app.js             surfaces, reader, TTS, triage, keyboard
    sw.js              offline shell (never caches /api)
    manifest.webmanifest
```

## Running it

```bash
npm install

# Create the database, then paste the returned id into wrangler.toml.
npx wrangler d1 create neatinfo
npx wrangler r2 bucket create neatinfo-raw     # optional; see §5.2

npm run db:local && npm run seed:local
npm run dev
```

`wrangler dev` reads secrets from `.dev.vars` (gitignored):

```
PASSPHRASE=whatever-you-like
SESSION_SECRET=some-long-random-string
```

Deploying:

```bash
npm run db:remote
npx wrangler secret put PASSPHRASE
npx wrangler secret put SESSION_SECRET
npm run deploy
```

## The decisions this code makes

**Surfaces are queries, not jobs.** Today, Pending and Archive are computed at
read time from `status` and `added_at`. The browser sends its own local midnight
as `dayStart`, so the boundary is correct in any timezone and there is no
scheduled worker to fail overnight. (§2.6)

**Lapse is a recorded transition, written lazily.** §2.6 wants no cron and §9.4
wants a real event to train on later. Both: `applyLapses()` runs on every feed
read and writes the `UPDATE` plus a `lapsed` event the first time a read notices
an item has aged past the window. Nothing is deleted, only demoted.

**Opened-but-undecided is a filter on Pending, not a fourth surface.** One
nullable `opened_at`, set on a real click. No impression tracking. (§2.3)

**Capture greedily, process lazily.** Ingest stores raw HTML (R2), full
extracted text, word count, HTTP status, fetch timestamp and the event stream —
all cheap now, all unrecoverable later. It computes nothing expensive: no
embeddings, no scoring, no LLM calls. Summaries come from `og:description`,
falling back to the first ~40 words. (§5.3, §3)

**A failed fetch still creates the article.** Login walls, PDFs and dead hosts
produce a row with the URL, a `fetch_status`, and a prompt to paste the text
instead. Never a dead end. (§3)

**Export ships in v1.** `GET /api/export` dumps articles, events and tags as
JSON. Losing the archive deletes the project's entire value. (§3)

**Auth is one passphrase in an env var.** A single-user tool has no multi-tenant
problem for an auth vendor to solve.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/session` | passphrase → signed cookie |
| `GET` | `/api/feed?dayStart&filter&q` | all three surfaces in one read |
| `POST` | `/api/articles` | `{url}` or `{text,title,source}`; 409 on duplicate |
| `GET` | `/api/articles/:id` | full record including body |
| `PATCH` | `/api/articles/:id` | `{notes, tags}` |
| `POST` | `/api/articles/:id/open` | sets `opened_at` |
| `POST` | `/api/articles/:id/listen` | sets `listened_at` |
| `POST` | `/api/articles/:id/resolve` | `{status: kept\|dismissed, favorite}` |
| `POST` | `/api/articles/:id/star` | toggle on an archived item |
| `GET`/`PUT` | `/api/settings` | lapse window |
| `GET` | `/api/export` | everything, as JSON |

## Known gaps, deliberately

- **PDFs are flagged, not parsed.** A non-HTML response saves the item with
  `fetch_status: 'non-html'` and asks you to paste the text. §9.5 is right that
  this matters for arXiv; it is a distinct code path and it is not built.
- **TTS is Tier 1 only** — the browser's own voice, in-page. It does not survive
  screen-lock on iOS. The player is behind a small seam so server-side audio in
  R2 drops in without touching the UI. (§6)
- **No curation, no scoring, no digests, no multi-topic UI.** `topic_id` is a
  first-class column everywhere and hard-coded to `1`. §7 and §8 are the map for
  later; there are no placeholders for them here.
- **Extraction is HTMLRewriter collecting block text**, not a readability port.
  Node readability libraries do not run on Workers. It is the cheap 80%.
