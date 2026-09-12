# NeatInfo — Product Requirements Document

**Owner:** Lucas
**Status:** Draft for Claude Design → build
**Last updated:** 2026-09-03

## 1. Summary

NeatInfo is a personal web app for collecting, triaging, and archiving interesting articles, studies, and thought pieces — starting with AI news, but built to scale to multiple topics later. Accessible from desktop and phone (responsive web app, not a local-only tool). The core loop: new items land on a **Today** front page, get flagged/rated as you read them, and move into a searchable **Archive** once consumed. Articles can arrive either by being logged for you or by pasting one in yourself.

**Platform decision:** since this needs to work on your phone, it's a hosted web app with a real backend (small API + database), not a folder of local Markdown files. Think: simple responsive frontend, lightweight backend (e.g. a serverless API + hosted Postgres/SQLite-on-the-edge), so it's reachable from any browser without syncing files around.

## 2. Core user story

> Each day (or on demand), I get a short list of interesting articles on a topic I care about. I skim the front page, flag the ones that are genuinely good, and read them. Once read, they roll off into an archive I can search later — so nothing gets lost and my front page never gets cluttered with old stuff.

## 3. Primary views

### 3.1 Today / Front page
- Shows the current batch of articles (e.g. today's 5), newest batch on top.
- Each card: title, source, date, 1–2 sentence summary, link.
- Quick actions per card: **Mark read**, **Flag as popular/favorite**, **Skip/dismiss**, **Add note**.
- Unread count badge.
- Optional: group by topic/tag if multiple topics are being tracked.

### 3.2 Archive
- Everything that's been marked read lands here automatically, in reverse-chronological order.
- Filters: by date range, by tag/topic, by source, by flagged/popular status, by read vs. skipped.
- Search bar (title, summary, notes, source).
- Each archived item keeps its original metadata plus your note and flag status.

### 3.3 Popular / Favorites
- A filtered view (not a separate data store) showing everything you've flagged as popular, across both Today and Archive.
- Useful as a "best of" list you can revisit or export.

### 3.4 Settings / Topics
- Manage the list of topics being tracked (start with just "AI," add more later — e.g. "climate tech," "gaming industry").
- Each topic gets its own Today feed and Archive filter; a top-level switcher/tab lets you jump between topics or view a merged feed.
- Control batch size (how many articles per refresh) and cadence (daily, every couple days, manual trigger) — settable per topic.

### 3.5 Add Article (paste-in)
- A prominent "+" / "Add article" action, available from any screen (especially easy to reach on mobile).
- Paste a URL, or paste raw text/a block of content, and NeatInfo adds it to the current topic's Today roster.
- On paste-URL: auto-fetch title, source, and publish date where possible, and generate the short summary.
- On paste-text (no URL): use the first line/heading as the title, let you set source manually, still auto-summarize.
- Lets you assign it to a topic on the way in if you're tracking more than one.

## 4. Feature brainstorm

### Content & ingestion
- **Paste-to-add** (see 3.5) as the primary v1 ingestion path — paste a URL or raw text, it lands on the roster.
- Manual "log these" flow (assistant-curated batches, what we're doing right now) as a secondary path.
- RSS/Atom feed ingestion from sites that publish one — legitimate, no login-dodging needed, and a lot of the sites you'd want (MIT Tech Review, TechCrunch, etc.) publish feeds.
- Official APIs where available (e.g. arXiv API for papers, NewsAPI-style aggregators) for structured metadata instead of scraping.
- A **browser clipper**: a small extension or bookmarklet that saves the page you're *already logged into and reading* into NeatInfo via the same paste-to-add pipeline — captures title, URL, your highlight/selection, and a summary. This gets you the "one click to save" convenience without touching anyone's paywall.
- Duplicate detection (same URL or near-identical title) so the same story doesn't get logged twice.

### Triage & organization
- Popular/favorite flag (star icon) with optional quick-reason tag ("well-argued," "surprising data," "good reference").
- Tags/categories, both auto-suggested (from source or keywords) and manual.
- "Skip" vs "Read" as distinct states — skipped items still archive but are visually distinct, so you can tell "I saw this and passed" from "I actually read it."
- Notes field per article — freeform thoughts, becomes searchable later.
- Rating (e.g. 1–5 or thumbs) if you want more granularity than just "popular."

### Discovery & summarization
- Auto-generated 1–2 sentence summaries for each item (already doing this manually — could be automated later).
- "Related articles" linking within the archive based on shared tags/topics.
- Weekly or monthly recap view: "here's what you flagged as popular this month."
- Trending-topics view across your own archive (e.g. "recursive self-improvement" came up 4 times this month).

### Reading experience
- Reader-mode extraction for public (non-paywalled) pages, so long articles render cleanly inside NeatInfo without ads/clutter.
- **Text-to-speech**: play button on any article that reads the summary or full extracted text aloud — great for commutes/chores on mobile. Adjustable playback speed, background/lock-screen playback controls (play, pause, skip), and a small "listened" indicator distinct from "read."
- Estimated read time (and listen time, once TTS exists) per article.
- Dark mode.
- Keyboard shortcuts for triage on desktop (e.g. `f` to flag, `r` to mark read, `s` to skip) for fast daily processing.

### Notifications & delivery
- Optional daily/weekly digest email or push notification summarizing the new batch.
- "Nothing new today" state instead of an empty page.

### Export & integration
- Export archive (or just the popular subset) to Markdown/CSV/Notion — handy for later reference or sharing.
- Since this already lives in a local folder (NeatInfo), the whole archive could just be a structured set of Markdown files or a lightweight local database (e.g. SQLite) rather than requiring a hosted backend.

### Mobile
- Responsive layout that works well one-handed on a phone (this is a primary usage mode, not an afterthought).
- Installable as a PWA (add-to-homescreen icon, works full-screen, no app-store submission needed) so it feels like a native app.
- Paste-to-add should work smoothly from a phone's share sheet where the platform allows it (e.g. share a link from another app straight into NeatInfo).

### Nice-to-haves / stretch
- Simple analytics: how many articles read/skipped per week, flag rate over time, per topic.
- "On this day" — resurface something you archived a year ago.
- Shareable read-only link to your popular list, if you ever want to share it with someone else.
- Downloadable audio (TTS export) for offline listening.

## 5. Explicitly out of scope

- **Paywall/login circumvention or full-site copying to avoid subscribing.** Not building this — it's both against most sites' terms of service and legally risky (unauthorized copying of copyrighted content). Legitimate alternatives that cover the same itch: RSS feeds, official APIs, reader-mode extraction on public pages, and the browser clipper for content you're already entitled to read.

## 6. Data model (rough sketch)

**Topic**
- id, name, active: boolean, batch_size, cadence

**Article**
- id, topic_id, title, url (optional, for pasted-text items), source, published_date, added_date
- content (extracted full text, when available), summary (short), notes (freeform)
- status: `new` | `read` | `skipped`
- flagged: boolean
- tags: string[]
- rating: optional int
- listened: boolean

Designing `topic_id` as a first-class foreign key from day one (even with only one active topic) keeps the schema scalable without a rework later.

## 7. Decisions so far

- **Platform:** hosted web app, mobile-responsive + installable as a PWA. Not local-only.
- **Topics:** single topic (AI) at launch, schema built to support many.
- **Ingestion:** paste-to-add (URL or raw text) is the primary path; assistant-curated batches and RSS are secondary/later.
- **Text-to-speech:** included as a core reading-experience feature.

## 8. Open questions for you before build

- For paste-to-add on paywalled/login-required pages, what's acceptable: pasting the raw text yourself (always fine, it's content you already have access to) vs. pasting just a URL and hoping it's publicly fetchable? Worth deciding the UX for "we couldn't fetch that URL, paste the text instead."
- TTS: fine with a browser-native voice (free, works offline-ish, robotic-ish) to start, or want a higher-quality AI voice API from day one (costs money per character, sounds much better)?
- Any preference on hosting stack, or happy to have Claude Design/the build step pick something sensible (e.g. Vercel + Postgres)?
