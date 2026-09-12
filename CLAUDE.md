# NeatInfo

Single-user article triage app for AI news. Collect, triage, archive. Cloudflare Workers + D1 + R2 + React.

## Project structure

```
app/
├── worker/           # Cloudflare Worker (API backend)
│   ├── index.js      # Router, feed queries, triage, candidate endpoints
│   ├── auth.js       # HMAC-SHA256 signed cookie auth
│   ├── extract.js    # HTMLRewriter extraction + HTML entity decoding
│   ├── search.js     # FTS5 query sanitising + archive filter SQL
│   ├── importer.js   # rebuilds a database from an export payload (pure)
│   ├── speech.js     # Tier 2: segmenting + MeloTTS, generated on demand
│   └── url.js        # URL normalization (UTM strip, arXiv dedup)
├── src/              # React 19 frontend (Vite 6)
│   ├── App.jsx       # Shell, nav, keyboard shortcuts
│   ├── AppContext.jsx # Global state, all API actions
│   ├── api.js        # Fetch wrapper, auth redirect, dayStart
│   ├── helpers.js    # Date math, read-time, archive query builder
│   └── components/   # Gate, Today, Pending, Archive, Discover,
│                     # Reader, TtsPlayer, ArticleCard, ArchiveRow,
│                     # AddSheet, SettingsSheet, Shortcuts, Toast
├── pipeline/         # V2 scoring pipeline, Python (GitHub Actions, nightly)
│                     #   NOT YET BUILT -- this is V1-33's target layout
│   ├── features.py   # Stage 1 heuristics: counting over text + raw HTML
│   ├── client.py     # pulls via /api/export, pushes features back
│   └── requirements.txt
├── discover/         # V2 discovery pipeline, JS (GitHub Actions, every 6h)
│   ├── index.js      # Orchestrator: fetch → dedup → score → POST
│   ├── rss.js        # RSS/Atom parser (zero deps)
│   ├── hn.js         # HackerNews Algolia API
│   ├── dedup.js      # URL + title-trigram Jaccard dedup
│   ├── score.js      # Keyword relevance + tier + recency scoring
│   └── url.js        # URL normalization (mirrors worker/url.js)
├── schema.sql        # D1 schema: article, candidate, feed_source, FTS5, events
├── migrations/       # one-off ALTERs for databases that already exist
├── scripts/          # standalone Node tools -- see scripts/README.md
│   ├── gather-candidates.mjs  # TLDR AI + Hacker News + HF daily papers
│   ├── seed-articles.mjs      # adds a candidate list via the app's own API
│   ├── repair-entities.mjs    # fixes rows stored before entity decoding
│   ├── import.mjs             # export payload -> SQL, for a restore
│   └── validate-capture.mjs   # checks raw captures are chunkable for v2
├── test/             # vitest, running inside workerd
├── vitest.config.js  # @cloudflare/vitest-pool-workers, bindings from wrangler.toml
├── .env.example      # copy to .env for the seeding scripts (gitignored)
├── wrangler.toml     # D1 + R2 bindings, SPA routing
├── vite.config.js    # React plugin, /api proxy to wrangler in dev
└── .github/workflows/
    ├── deploy.yml    # CI: test → build → D1 migrate → wrangler deploy
    ├── discover.yml  # Cron every 6h: run discovery pipeline
    └── pipeline.yml   # Cron nightly: Stage 1 features (V1-33, not yet built)
```

## Architecture decisions

- **Surfaces are computed at query time.** Today/Pending/Archive are not stored statuses — the feed endpoint derives them from `status`, `added_at` vs the client's `dayStart` parameter, and `origin`. No timezone stored server-side. Today and Pending are exact complements: anything undecided is on one or the other, never both, never neither.
- **Lazy lapse, no cron.** Articles older than N days auto-archive as "lapsed" on every `getFeed` call. Zero scheduled Workers in V1.
- **Event log from day one.** Every action (added, opened, kept, dismissed, starred, unstarred, lapsed, listened) is written to the `event` table. No V1 behaviour reads it — V2 uses it for scoring feedback.
- **Origin field.** Articles have `origin: 'manual' | 'auto'`. Manual articles go to Today; auto-discovered ones go to Pending so the daily page can't be flooded.
- **R2 budget cap.** Per-file 2MB, 8GB total. Usage is counted in a D1 `setting` row (`r2_usage_bytes`), not in an R2 object: the old counter was an R2 read-modify-write, so two concurrent adds lost one of the two counts and a deletion never subtracted. `/api/settings` re-measures the bucket authoritatively, since only a walk of it can see a deleted object.
- **HTMLRewriter extraction.** No npm readability library — uses Cloudflare's native streaming parser. ~80% accuracy, good enough for a personal tool.
- **Discovery pipeline runs in GitHub Actions**, not Workers. Full Node.js runtime, no execution time limits, free 2000 min/month.
- **Two languages, one data contract.** The Worker and `discover/` are JavaScript; `pipeline/` and the Colab notebooks for training and evaluation are Python. They never import each other — `pipeline/` reads through `/api/export` and writes features back through the API. That boundary is deliberate: features are *stored*, never recomputed on the other side, so a feature definition cannot drift between the thing that scores and the thing that trains. Measured against the alternative, nothing here needs distributed compute: the whole corpus is ~176k tokens, and an 8B model reads it for ~1,000 neurons of a 10,000/day free allowance.

## Development

**Node 22+ is required** (`engines` in package.json, `.nvmrc`). Wrangler 4 refuses to start on Node 20, which makes every `wrangler` command fail with what looks like a wrangler problem.

Two terminals — frontend dev server and Wrangler:
```
cd app && npm run dev:frontend   # Vite on :5173, proxies /api to :8787
cd app && npm run dev:worker     # Wrangler on :8787, reads .dev.vars
```

Or just Wrangler (serves built assets from dist/):
```
cd app && npm run build && npx wrangler dev
```

Run tests: `cd app && npm test`

Tests run inside **workerd**, not Node, so HTMLRewriter, D1 and R2 behave as in production. The pool shares one D1 file across tests — `resetDb()` in `test/helpers.js`, called in `beforeEach`, is what makes them independent.

## Key conventions

- **All API actions go through `AppContext.jsx`** — components never call `api()` directly. Every action is wrapped in `guard()` which handles 401 redirects and error toasts. *Known exception to fix:* `TtsPlayer.jsx` calls `api()` directly for `/listen`, and passes it into the speech engine as `fetchJson` for the audio manifest.
- **Worker secrets** (`PASSPHRASE`, `SESSION_SECRET`, `DISCOVER_KEY`) are set via `wrangler secret put`, never in code. Local dev uses `.dev.vars`.
- **URL normalization** exists in two places: `worker/url.js` (Workers runtime) and `discover/url.js` (Node.js). Keep them in sync when changing dedup rules.
- **Schema changes** go in `schema.sql` and use `CREATE IF NOT EXISTS` / `INSERT OR IGNORE` so the file is idempotent -- the deploy workflow re-runs it on every push. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a column added to an *existing* database cannot live there: it goes in `migrations/`, run by hand once per database, **before** the deploy that needs it.
- **Dependencies are a per-component decision, not a project rule.** `discover/` is deliberately zero-dependency (RSS parsing is regex-based) because it runs every 6 hours and install time is in its hot path — worth preserving, but it is a property of that job, not of the repo. `pipeline/` is Python and has dependencies by design: it is where scoring, feature extraction and eventually NER live, and the ecosystem for that work is Python. Cached installs make the difference negligible for a nightly job.

## Deployment

```
cd app && npm run deploy          # vite build + wrangler deploy
```

Schema migrations (remote):
```
cd app && npx wrangler d1 execute neatinfo --remote --file=./schema.sql --yes
```

GitHub Actions needs: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEATINFO_API_URL`, `NEATINFO_DISCOVER_KEY`.

The API token must have D1 Edit permission in addition to the standard Workers permissions.

## Don't

- Don't add npm dependencies to `discover/` — it is zero-dep on purpose and runs every 6 hours. (This does not apply to `pipeline/`, which is Python and has its own requirements.)
- Don't store timezone info server-side — the client sends `dayStart` and that's the contract.
- Don't put auto-discovered articles in Today — use `origin: 'auto'` so they land in Pending.
- Don't read the `event` table to drive V1 behaviour — it's a write-ahead investment for V2 scoring. (`/api/export` copies it wholesale; that's a backup, not logic.)
- Don't skip the `guard()` wrapper in AppContext — unguarded API calls leave unhandled rejections.
