# NeatInfo

Single-user article triage app for AI news. Collect, triage, archive. Cloudflare Workers + D1 + R2 + React.

## Project structure

```
app/
├── worker/           # Cloudflare Worker (API backend)
│   ├── index.js      # Router, feed queries, triage, candidate endpoints
│   ├── auth.js       # HMAC-SHA256 signed cookie auth
│   ├── extract.js    # HTMLRewriter article extraction
│   └── url.js        # URL normalization (UTM strip, arXiv dedup)
├── src/              # React 19 frontend (Vite 6)
│   ├── App.jsx       # Shell, nav, keyboard shortcuts
│   ├── AppContext.jsx # Global state, all API actions
│   ├── api.js        # Fetch wrapper, auth redirect, dayStart
│   ├── helpers.js    # Date math, read-time, archive query builder
│   └── components/   # Gate, Today, Pending, Archive, Discover,
│                     # Reader, TtsPlayer, ArticleCard, ArchiveRow,
│                     # AddSheet, SettingsSheet, Shortcuts, Toast
├── discover/         # V2 discovery pipeline (runs in GitHub Actions, not Workers)
│   ├── index.js      # Orchestrator: fetch → dedup → score → POST
│   ├── rss.js        # RSS/Atom parser (zero deps)
│   ├── hn.js         # HackerNews Algolia API
│   ├── dedup.js      # URL + title-trigram Jaccard dedup
│   ├── score.js      # Keyword relevance + tier + recency scoring
│   └── url.js        # URL normalization (mirrors worker/url.js)
├── schema.sql        # D1 schema: article, candidate, feed_source, FTS5, events
├── wrangler.toml     # D1 + R2 bindings, SPA routing
├── vite.config.js    # React plugin, /api proxy to wrangler in dev
└── .github/workflows/
    ├── deploy.yml    # CI: test → build → D1 migrate → wrangler deploy
    └── discover.yml  # Cron every 6h: run discovery pipeline
```

## Architecture decisions

- **Surfaces are computed at query time.** Today/Pending/Archive are not stored statuses — the feed endpoint derives them from `added_at` vs the client's `dayStart` parameter. No timezone stored server-side.
- **Lazy lapse, no cron.** Articles older than N days auto-archive as "lapsed" on every `getFeed` call. Zero scheduled Workers in V1.
- **Event log from day one.** Every action (added, opened, kept, dismissed, starred, lapsed, listened) is written to the `event` table. V1 never reads it — V2 uses it for scoring feedback.
- **Origin field.** Articles have `origin: 'manual' | 'auto'`. Manual articles go to Today; auto-discovered ones go to Pending so the daily page can't be flooded.
- **R2 budget cap.** Per-file 2MB, 8GB total, tracked via `_usage` metadata object. Settings API exposes usage.
- **HTMLRewriter extraction.** No npm readability library — uses Cloudflare's native streaming parser. ~80% accuracy, good enough for a personal tool.
- **Discovery pipeline runs in GitHub Actions**, not Workers. Full Node.js runtime, no execution time limits, free 2000 min/month.

## Development

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

## Key conventions

- **All API actions go through `AppContext.jsx`** — components never call `api()` directly. Every action is wrapped in `guard()` which handles 401 redirects and error toasts.
- **Worker secrets** (`PASSPHRASE`, `SESSION_SECRET`, `DISCOVER_KEY`) are set via `wrangler secret put`, never in code. Local dev uses `.dev.vars`.
- **URL normalization** exists in two places: `worker/url.js` (Workers runtime) and `discover/url.js` (Node.js). Keep them in sync when changing dedup rules.
- **Schema changes** go in `schema.sql` and use `CREATE IF NOT EXISTS` / `INSERT OR IGNORE` so the file is idempotent and re-runnable.
- **The discover script has no npm dependencies.** RSS parsing is regex-based. Keep it that way — it runs in GitHub Actions where install time matters.

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

- Don't add npm dependencies to `discover/` — it intentionally has none.
- Don't store timezone info server-side — the client sends `dayStart` and that's the contract.
- Don't put auto-discovered articles in Today — use `origin: 'auto'` so they land in Pending.
- Don't read the `event` table in V1 code — it's a write-ahead investment for V2 scoring.
- Don't skip the `guard()` wrapper in AppContext — unguarded API calls leave unhandled rejections.
