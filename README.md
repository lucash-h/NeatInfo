# NeatInfo

Implementation of `NeatInfo.dc.html` (Claude Design) against the v1 scope in
`../NeatInfo_Design_Report.md`: **pull, show, deal with, store.**

A single-user reading tracker with three surfaces — **Today** (added today),
**Pending** (older, undecided, oldest first), and **Archive** (kept,
dismissed, or lapsed — terminal, searchable forever, nothing ever deleted).
Anything left in Pending past the lapse window (default 14 days) is
auto-resolved to `lapsed` so the queue can never become a guilt pile. One
Cloudflare Worker serves both the API and the built frontend; D1 holds the
queryable data, R2 holds raw HTML.

```
app/
  wrangler.toml           bindings + secrets checklist
  schema.sql              D1 schema, FTS5 index, seed topic
  seed.sql                sample rows for local dev only
  vite.config.js          dev server + proxy to wrangler dev
  vitest.config.js        tests run inside workerd via @cloudflare/vitest-pool-workers
  index.html              Vite entry point (mounts src/main.jsx)
  worker/
    index.js              router, surfaces, transitions, ingest, export
    extract.js            HTMLRewriter extraction (+ arXiv abstract path), truncation
    auth.js                single passphrase, HMAC-signed cookie
    url.js                 URL normalization for duplicate detection
    search.js               FTS5 query building + archive filters
  src/
    main.jsx               React entry point
    App.jsx                shell: surface switching, keyboard shortcuts, share-target
    AppContext.jsx          feed/filter/facet state, all API calls
    api.js                  fetch wrapper, 401 handling
    helpers.js               display logic shared by components (read time, lapse info, ...)
    tts.js                   chunking + engine seam for text-to-speech (§6)
    styles.css               design-canvas tokens
    components/
      Gate.jsx               passphrase screen
      Today.jsx, Pending.jsx, Archive.jsx, ArchiveRow.jsx   the three surfaces
      ArticleCard.jsx         card shown on Today/Pending
      Reader.jsx              detail view: notes, tags, fill-in-text, refetch
      AddSheet.jsx            paste-a-URL / paste-text form
      SettingsSheet.jsx        lapse window + R2 usage
      TtsPlayer.jsx            play/pause/stop UI over tts.js
      Toast.jsx, ErrorBoundary.jsx
  public/
    icon.svg, icon-maskable.svg    PWA icons
    manifest.webmanifest            PWA manifest + share-target
    sw.js                           offline shell only, never caches /api
  scripts/
    validate-capture.mjs    §5.4 script: checks raw captures are chunkable for v2
  test/                     the suite, run inside workerd (see "Running the tests")
  .github/workflows/deploy.yml   test -> build -> migrate -> deploy, on push to main
```

`dist/` (Vite's build output) and `.wrangler/` (local D1/R2 state) are both
gitignored; the Worker builds `dist/` fresh on every deploy.

## Local development

```bash
npm install
```

Two dev servers, for two different things:

- **`npm run dev:frontend`** — runs `vite`. Fast HMR for React work. It proxies
  `/api/*` to `http://localhost:8787` (see `vite.config.js`), so it needs
  `wrangler dev` running alongside it if you want working API calls.
- **`npm run dev:worker`** — runs `wrangler dev`. Serves the actual Worker
  (API + D1 + R2 bindings) against local storage. Use this on its own when
  you're only touching `worker/`, or together with `dev:frontend` for full-stack
  work.

Both read secrets from `.dev.vars` (gitignored). Copy `.dev.vars.example` to
`.dev.vars` and put your own values in it — never commit real secrets, and
never put them in `wrangler.toml`:

```
PASSPHRASE=<pick anything>
SESSION_SECRET=<pick a long random string>
```

Seed local D1 before you have any real data:

```bash
npm run db:local     # applies schema.sql to local D1
npm run seed:local   # applies seed.sql -- sample rows for local dev only
```

## Running the tests

```bash
npm test         # vitest run -- one pass
npm run test:watch
```

The one non-obvious thing: tests run inside **workerd**, not Node, via
`@cloudflare/vitest-pool-workers` (see `vitest.config.js`), so `HTMLRewriter`,
D1 and R2 behave the way they do in production instead of the way a mock
would. The pool runs as a single worker and no longer rolls storage back
between tests, so **all tests share one D1 file** — `resetDb()` in
`test/helpers.js` is what makes each test independent; every stateful test
file calls it in `beforeEach`.

## Deploying

`.github/workflows/deploy.yml` runs on every push to `main`:

1. checkout, `npm ci`
2. `npm test` — gates everything after it; a broken worker never reaches the
   build step or the remote D1 schema
3. `npm run build` (Vite build into `dist/`, which the Worker's `[assets]`
   binding serves)
4. apply `schema.sql` to the remote D1 database (`wrangler d1 execute --remote`)
5. `npx wrangler deploy`

It needs two repository secrets: `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

One step is deliberately **not** automated: setting the actual secret values
the Worker reads at runtime. Run these once (and again whenever you rotate
them):

```bash
npx wrangler secret put PASSPHRASE
npx wrangler secret put SESSION_SECRET
```

`npm run deploy` (`vite build && wrangler deploy`) does the build-and-deploy
half by hand, without the test gate or the migration step — useful for a quick
manual push, not a substitute for the workflow.

## API

All routes except `/api/session` require the session cookie (`POST
/api/session` first).

| Method | Path | |
|---|---|---|
| `POST` | `/api/session` | `{passphrase}` -> signed cookie |
| `GET` | `/api/session` | `{authed}` |
| `DELETE` | `/api/session` | clears the cookie |
| `GET` | `/api/feed?dayStart&filter&q&status&favorite&source&tag&from&to&limit&offset` | Today, Pending and a page of Archive in one read |
| `GET` | `/api/facets` | sources/tags/earliest-date for the archive filter bar |
| `POST` | `/api/articles` | `{url}` or `{text,title,source}`; 409 on duplicate |
| `GET` | `/api/articles/:id` | full record, including `body_text` |
| `PATCH` | `/api/articles/:id` | `{notes, title, source, body_text, tags}` |
| `POST` | `/api/articles/:id/open` | sets `opened_at` |
| `POST` | `/api/articles/:id/listen` | sets `listened_at` |
| `POST` | `/api/articles/:id/resolve` | `{status: kept\|dismissed, favorite}` |
| `POST` | `/api/articles/:id/star` | `{favorite}` -- toggle on an archived item |
| `POST` | `/api/articles/:id/refetch` | re-runs extraction on an item's URL |
| `GET` | `/api/articles/:id/raw` | streams the raw HTML from R2, if kept |
| `GET`/`PUT` | `/api/settings` | lapse window, R2 usage |
| `GET` | `/api/export` | articles, events, tags, settings, topics and the R2 key manifest, as JSON |

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

**Export ships in v1, and restores.** `GET /api/export` dumps every table as
JSON; `scripts/import.mjs` turns that payload back into SQL, and a round-trip
test asserts the database comes back row for row. Losing the archive deletes
the project's entire value. (§3)

**Auth is one passphrase in an env var.** A single-user tool has no multi-tenant
problem for an auth vendor to solve.

## Known gaps, deliberately

- **PDFs are flagged, not parsed.** A non-HTML response saves the item with
  `fetch_status: 'non-html'` and asks you to paste the text. §9.5 is right that
  this matters for arXiv; it is a distinct code path and it is not built.
  (arXiv `/abs/` pages, which are ordinary HTML, are extracted directly.)
- **TTS is Tier 1 only** — the browser's own voice, in-page. It does not survive
  screen-lock on iOS. The player is behind a small seam so server-side audio in
  R2 drops in without touching the UI. (§6)
- **No curation, no scoring, no digests, no multi-topic UI.** `topic_id` is a
  first-class column everywhere and hard-coded to `1`. §7 and §8 are the map for
  later; there are no placeholders for them here.
- **Extraction is HTMLRewriter collecting block text**, not a readability port.
  Node readability libraries do not run on Workers. It is the cheap 80%.
