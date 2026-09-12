# NeatInfo — Technical Stack Brainstorm (free/low-cost, scalable)

**Companion to:** NeatInfo_PRD.md
**Last updated:** 2026-09-03

## TL;DR recommendation

For a single-user personal app with light traffic, **any** of the stacks below will comfortably sit in the free tier for a very long time — the real "scalability" work is the data model (already handled: `topic_id` as a first-class field) and picking a stack you won't have to migrate off later, not squeezing more free quota. Given that, my pick is:

**Cloudflare Pages + Workers + D1 + R2**, browser-native TTS, no third-party auth (single shared passphrase). One vendor, generous limits, no surprise pauses, scales to real traffic without a rewrite. Details and two alternatives below.

## Important framing: you probably don't need "auth" at all

This is a single-user tool. Full auth systems (signup, password reset emails, sessions, OAuth) solve a multi-tenant problem you don't have. Cheapest and simplest: a single passphrase stored as a server-side environment variable, checked against a login form, issuing a signed cookie/session token. No auth vendor, no per-monthly-active-user limits to worry about, nothing to outgrow. Worth revisiting only if you ever want to share NeatInfo with someone else.

## Piece by piece

### Frontend hosting
Claude Design will hand you static HTML/CSS/JS (or a React app). Any of these serve it free with no "commercial use" issue since this is a personal tool:
- **Cloudflare Pages** — unlimited requests/bandwidth on the free tier, global CDN, pairs natively with Workers/D1 below.
- **Vercel (Hobby)** — 100 GB bandwidth/month, 100k function calls/month, single developer only, "no commercial use" clause (fine for personal use, matters if this ever monetizes).
- **Netlify** — comparable free tier to Vercel, similar caveats.

All three support PWA installability (manifest + service worker) at no extra cost — that covers the "add to homescreen on my phone" requirement.

### Backend / API
- **Cloudflare Workers** — serverless functions at the edge, extremely generous free tier (100k requests/day), no cold-start pause behavior.
- **Vercel serverless/edge functions** — bundled with Vercel hosting, 100k invocations/month free, 10s max execution time.
- **Supabase Edge Functions** — bundled if you go the Supabase route below, 500k invocations/month free.

### Database
This is the part most likely to matter for "scalable," since it's where your archive grows over time.

| Option | Free tier | Notes |
|---|---|---|
| **Cloudflare D1** (SQLite at the edge) | Generous free tier, pairs with Workers/Pages | Great fit for an article-archive schema (relational, not huge blobs); single-vendor simplicity |
| **Supabase** (Postgres) | 500 MB DB, 5 GB bandwidth, 1 GB file storage, 2 projects; **pauses after 1 week of inactivity** on free tier | All-in-one: DB + Auth + Storage + Edge Functions in one dashboard. The inactivity pause matters less for a daily-use app, but worth knowing. |
| **Neon** (serverless Postgres) | 0.5 GB/project (5 GB across up to 100 projects), 100 compute-hours/month, scale-to-zero | Real Postgres, branching (handy for testing schema changes), pairs well with Vercel |

500 MB–5 GB of article metadata (titles, summaries, notes, tags — no video/huge media) is realistically **years** of daily archiving before you'd need to pay for storage, on any of these.

### File/media storage
Only relevant if you start storing full article text, generated TTS audio files, or images:
- **Cloudflare R2** — free egress (this is the standout feature vs. S3-style pricing elsewhere), 10 GB free storage.
- **Supabase Storage** — 1 GB free, bundled if you're already on Supabase.

### Text-to-speech
- **Browser-native Web Speech API** — completely free, zero server cost, works offline-ish, built into Chrome/Safari/Edge. Quality is "robotic-ish" but very usable, and it's literally $0 forever since it runs on the visitor's device, not your server. **Recommended starting point.**
- **ElevenLabs free tier** — 10k credits/month, but **no API access on the free plan** and no commercial use — a dead end for actually wiring it into your app programmatically. Only their paid tiers unlock API access.
- **Cloud TTS APIs with real free tiers** (worth a look when you want higher quality): Google Cloud TTS and Azure both have small perpetual free monthly quotas (roughly low-single-digit-millions of characters, standard voices) alongside a low per-character cost after that, e.g., a service you could add later as a toggle ("higher quality voice") without ripping out the browser fallback.

### Content extraction (for paste-a-URL)
No paid service needed: fetch the URL server-side in your Worker/function and run it through an open-source readability parser (e.g., Mozilla's `readability` library, or `@extractus/article-extractor`) to pull title, byline, date, and clean text. Free, self-hosted, no rate limits beyond your own hosting.

## Three concrete stack options

### Option A — Cloudflare all-in-one (recommended)
- Frontend: Cloudflare Pages
- Backend: Cloudflare Workers
- DB: Cloudflare D1
- Storage (if/when needed): Cloudflare R2
- TTS: Web Speech API, no server cost
- Auth: single passphrase, no vendor
- **Why:** one vendor, one dashboard, no inactivity pausing, free tier headroom is large, and it scales to real paid traffic later without switching platforms.

### Option B — Supabase all-in-one (easiest to get started)
- Frontend: Vercel or Netlify (Supabase doesn't host frontends)
- Backend/DB/Storage/Auth: Supabase (Postgres + Edge Functions + Storage, skip their Auth in favor of the passphrase approach to keep it simple)
- TTS: Web Speech API
- **Why:** Supabase's dashboard (table editor, built-in API explorer) is the most beginner-friendly if you want to poke at the database directly without writing raw SQL migrations. Tradeoff: free projects pause after a week of inactivity — a minor annoyance if you skip a week, not a dealbreaker for a daily-habit app.

### Option C — Vercel + Neon (Postgres purist)
- Frontend + Backend: Vercel (Next.js app, API routes)
- DB: Neon serverless Postgres
- TTS: Web Speech API
- **Why:** if you specifically want "real" Postgres with branching for testing schema changes (e.g., trying a new tags structure on a branch before merging), this is the cleanest combo. Slightly more moving pieces than Option A since frontend and DB are different vendors.

## Cost trajectory if this ever outgrows free tiers

Even at meaningful daily use (hundreds of articles/month, TTS on most of them, phone + desktop access), you'd likely stay free for a long time on any option above. If you ever do outgrow it: Cloudflare's paid tier starts around $5/month for Workers, Neon/Supabase paid Postgres starts around $19–25/month, and a paid TTS API is metered per character (cheap in bulk — typically a few dollars per million characters). None of these are "surprise $500 bill" services at this scale.

## Open question for you

Given the tradeoffs above, want me to lock in **Option A (Cloudflare)** as the target stack for the build step, or do you have a preference (e.g., you already have a Vercel/Supabase account you'd rather build on)?
