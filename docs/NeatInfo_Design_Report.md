# NeatInfo — Design Report: State Model, V1 Scope, and the V2 Value Pipeline

**Companion to:** NeatInfo_PRD.md, NeatInfo_Stack_Brainstorm.md
**Date:** 2026-09-03 (rev. 2)
**Purpose:** Work the loose ends in the PRD into something concrete enough to build from, split cleanly into v1 (collect and triage) and v2 (evaluate and score). Section 9 is a fresh-eyes critique of everything above it.

---

## 1. Decisions locked

| Decision | Choice |
|---|---|
| Platform | Hosted responsive web app, installable as PWA |
| Stack | Cloudflare Pages + Workers + D1 (+ R2, Vectorize later) |
| Auth | Single server-side passphrase, no auth vendor |
| Topics | Single topic at launch, `topic_id` in schema from day one |
| V1 goal | Pull, show, deal with, store |
| V1 curation | Stays manual (assistant-curated batches pasted in); automation blueprinted in §7, not built |
| V2 goal | Ingestion pipeline that quantifies article value |
| **V2 framing** | **Explicitly a learning project.** Scoped as a ladder of stages that each teach something and each ship working. |

---

## 2. The state model

### 2.1 The problem being solved

The failure mode of every read-it-later tool is the infinite queue: items arrive faster than they're resolved, the front page becomes a guilt pile, and you stop opening the app. The fix isn't discipline, it's making the front page **time-scoped rather than queue-scoped**, and giving unresolved items an automatic exit.

### 2.2 Three surfaces

**Today** — articles added today (in your local timezone). Bounded by definition; it cannot grow without bound because tomorrow it's a different set. This is the page you actually work.

**Pending** — articles from previous days that never got a decision. The honest "I didn't get to it" pile. Sorted oldest-first so the stalest items are what confront you.

**Archive** — terminal state. Everything with a resolution, searchable forever. Nothing is ever deleted, only demoted.

### 2.3 Where the "seen" idea lands

Rather than a fourth surface for seen-but-unactioned items, fold it into Pending as a **filter**: track `opened_at` (set when you open the detail/reader view) and let Pending toggle between *All / Opened but undecided / Never opened*.

Rationale: four top-level surfaces is too many for a phone, and both groups want the same actions. But the distinction is real — "I opened this and got distracted" is a meaningfully different signal from "I never clicked it," and it becomes a training label in v2.

Needs no impression tracking (no scroll-depth, no viewport heuristics) — just one nullable timestamp set on a real click.

### 2.4 The lapse rule — the most important parameter in the design

Pending becomes the new guilt pile unless items can leave it without your involvement. So:

> Anything in Pending for more than **N days** (default 14) is auto-resolved as `lapsed` and moves to Archive.

`lapsed` is non-destructive: still searchable, still archived, just off your active surfaces. This is what makes the model psychologically safe — you can ignore things without losing them, so there's no cost to ignoring them, so you don't avoid the app.

Make N a setting, pick a sane default, don't draw attention to it. Fiddling with the window is procrastination disguised as configuration.

### 2.5 Terminal actions

| Action | Result |
|---|---|
| **Keep** | → Archive, `kept`. Read it, worth having. |
| **Star** | → Archive, `kept` + `favorite: true`. The subset worth revisiting. |
| **Dismiss** | → Archive, `dismissed`. Saw it, not worth it. |
| *(no action, N days)* | → Archive, `lapsed`. Automatic. |

`rating` is cut from v1 — a 5-point scale you'll never apply consistently adds a column and a decision without adding information. Star/no-star is the honest granularity for one user.

`read` vs `listened` becomes two nullable timestamps (`opened_at`, `listened_at`) rather than boolean states. Same cost, and they tell you *when*, which v2 wants.

### 2.6 Rollover mechanics: a query, not a job

The obvious implementation is a nightly cron moving rows between states. Don't. It needs to fire at *your* local midnight (a UTC cron fires mid-afternoon in Vancouver), and a failed job leaves the app wrong until someone notices.

Compute the surfaces at read time instead:

- **Today** = `status = 'new' AND added_at >= start_of_today(user_tz)`
- **Pending** = `status = 'new' AND added_at < start_of_today(user_tz)`
- **Archive** = `status != 'new'`

Timezone-correct by construction, no scheduled worker, nothing to fail overnight. **V1 needs zero cron jobs.** (Lapse is the one exception — see §9.4.)

---

## 3. V1 scope: pull, show, deal with, store

Everything below is in. Everything not below is out. That boundary is the point of this section.

### Pull
- Paste a URL → Worker fetches the page, extracts title, source, publish date, author, clean body text
- Paste raw text → you supply title and source manually
- Duplicate detection on normalized URL (strip UTM params, trailing slashes, `?ref=`)
- Graceful failure: if fetch fails or hits a login wall, the item is still created with the URL and a prompt to paste text instead — never a dead end

### Show
- Today, Pending (with the opened/unopened filter), Archive
- Article detail / reader view
- Card shows: title, source, date, short summary, estimated read time
- **Summaries in v1 come from `og:description` / meta description, falling back to the first ~40 words of extracted body.** Free, no LLM call, no API key. LLM summarization is a v2 upgrade, not a v1 dependency.

### Deal with
- Keep / Star / Dismiss
- Note field (freeform, searchable)
- Manual tags
- TTS playback (§6)

### Store
- D1 with SQLite FTS5 full-text index over title, summary, body, notes
- Filters: date range, source, tag, status, favorite
- **Export endpoint dumping everything to JSON.** In v1, not stretch. You're building an archive meant to accumulate for years; losing it deletes the project's entire value. An afternoon of work.

### Explicitly not v1
Automated curation (blueprinted in §7), browser clipper, LLM summaries, digest emails, recap/analytics views, related-articles linking, multi-topic UI, any scoring.

---

## 4. V1 data model

```
Topic
  id, name, active, created_at

Article
  id, topic_id
  url (nullable), url_normalized (nullable, unique per topic)
  title, source, author (nullable), published_at (nullable)
  body_text (nullable), summary
  raw_html_key (nullable)        -- R2 object key, see §5
  status: 'new' | 'kept' | 'dismissed' | 'lapsed'
  favorite: boolean
  notes (nullable)
  added_at, opened_at (nullable), listened_at (nullable), resolved_at (nullable)
  word_count
  fetch_status, fetched_at       -- see §5.3

Tag            id, name
ArticleTag     article_id, tag_id        -- join table; a string[] column isn't relational

Event          id, article_id, type, created_at
               -- 'added' | 'opened' | 'kept' | 'starred' | 'dismissed' | 'lapsed' | 'listened'
```

The `Event` table isn't needed by v1. It's there because v2 needs behavioral history and reconstructing one after the fact is impossible.

---

## 5. Storage and retention: is "inefficient" fine?

Short answer: **yes, and you should deliberately over-capture.** But the framing "efficient vs. inefficient" is the wrong axis. The right one is **recoverable vs. unrecoverable**.

### 5.1 Why inefficiency is genuinely cheap here

At ~5 articles/day you generate ~1,800/year. Extracted body text runs 5k words ≈ 30KB, so a year of full text is roughly **50MB**. D1's free tier handles that comfortably for many years. Storage efficiency is simply not the binding constraint at your volume, and optimizing it now would be premature.

### 5.2 What *is* the constraint: raw HTML belongs in R2, not D1

The one place "store everything" actually bites. Raw page HTML for a modern news site runs 200KB–2MB. A year of that is **500MB–1GB+**, which would blow past a free-tier D1 database that's fine holding text alone.

So split by size:

| Data | Where | Why |
|---|---|---|
| Metadata, body text, notes, events | **D1** | Small, queryable, needs FTS and joins |
| Raw HTML, TTS audio files | **R2** | Large blobs, 10GB free, free egress, keyed by article id |

This keeps the queryable database small and fast while letting you hoard the bulky raw material at effectively no cost. It's also why the schema has `raw_html_key` rather than a raw HTML column.

### 5.3 The thing that's actually unrecoverable

Disk space is cheap and reversible. **Data you didn't capture is gone forever.** Two specific risks:

- **Link rot** — the article you saved in 2026 may 404 in 2028. If you kept only the URL, that entry is now a dead reference.
- **Content drift** — articles get edited, paywalls tighten, sites reorganize. Re-fetching later doesn't reliably give you what you read.

So the retention rule isn't "store efficiently," it's **"capture greedily at ingest, process lazily forever after."** Specifically, capture at ingest even though v1 doesn't use it: raw HTML (→R2), full extracted text, the HTTP status and fetch timestamp, the original publish date, and the full event stream. All cheap now, all impossible to reconstruct later.

The corollary: **don't compute anything expensive at ingest.** No embeddings, no scoring, no LLM calls in v1. Those can be backfilled over the whole archive whenever you build v2, precisely because you kept the raw material.

### 5.4 One discipline to keep

"We'll process it later" has a real failure mode: the raw capture turns out to have the wrong *shape* for what v2 needs, and you don't find out for a year. Cheap insurance — after week one, run a throwaway script over the ~35 articles you've collected and check you can actually extract what §8 wants (specificity counts, outbound links, clean chunkable text). Ten minutes to validate a year of assumptions.

---

## 6. Text-to-speech, honestly

Two tiers, because one is free and one isn't:

**Tier 1 (v1, free):** Web Speech API, in-page playback. Works while you're looking at the app. Does *not* survive screen-lock or backgrounding on iOS — the "listen on a walk" case does not work.

**Tier 2 (later):** server-side TTS generating an audio file, stored in R2, played through an `<audio>` element with the Media Session API for real lock-screen controls. Costs money per character; the only way to get background playback.

Build Tier 1 with the player behind a small interface so Tier 2 drops in without touching the UI. Don't build Tier 2 until you've confirmed you actually listen.

---

## 7. Blueprint: automating the daily 5

Not being built in v1 — curation stays manual (batches produced in chat and pasted in). This is the map for when you want it.

### 7.1 The key realization

Fetching candidates is easy. **Selecting 5 from ~200 is the entire problem — and it's the same problem v2 solves**, just applied at the front of the pipeline instead of the back. Auto-curation and value-scoring are one system wearing two hats. That's the main argument for sequencing: build the scorer first, then point it at a firehose. Pointing a firehose at yourself *before* you have a scorer just relocates the triage work.

### 7.2 Candidate sources (all free)

| Source | Access | Notes |
|---|---|---|
| **RSS/Atom feeds** | Direct fetch, parse in Worker | MIT Tech Review, TechCrunch, most publications. The backbone. |
| **arXiv API** | Official, free, no key | Structured metadata for papers. Query by category (cs.AI, cs.LG) and date. |
| **Hacker News** | Algolia HN API, free, no key | Excellent signal — points and comment counts are a real external popularity measure. Also answers the earlier "popular" ambiguity if you ever wanted crowd signal rather than personal starring. |
| **Reddit** | `.json` on any listing, or RSS | r/MachineLearning etc. Rate-limited but free. |
| **Google News RSS** | RSS by query | Broad, noisy, good for catching things your feeds miss. |
| **Newsletters** | Cloudflare Email Routing → Worker | See below — probably the highest-value option. |

### 7.3 The newsletter trick

Cloudflare Email Routing (free) can route an address to a Worker. Point it at a dedicated inbox, subscribe that inbox to the good hand-curated AI newsletters, and parse the links out of the emails.

Why this is strong: you're **borrowing human curation that already happened**. Someone competent already read 200 things and picked 10. Parsing their picks gets you most of the quality of a scoring pipeline for a fraction of the work, and it stays free. Downside in §9.6.

### 7.4 Pipeline shape

```
poll sources (Cron Trigger, daily)
  → normalize to {title, url, source, published_at, snippet}
  → filter (topic keywords, date window, already-seen URLs)
  → cluster near-duplicates (same story from 5 outlets → one entry)
  → rank
  → take top N
  → insert into Today
```

**Clustering is the underrated step.** Without it, a big story gives you 5 items that are all the same story, and your daily batch is one piece of news. Cheap approaches: normalized-title fuzzy match, or embedding similarity with a threshold once you have embeddings anyway.

### 7.5 Ranking options, cheapest first

1. **Source tier list** — hand-ranked publications. Five minutes of work, surprisingly hard to beat.
2. **External signal** — HN points, comment volume. Free, genuinely informative.
3. **LLM headline triage** — hand a model 100 titles + snippets, ask for the 5 most interesting given a description of your interests. Costs cents at this volume, works well, needs no training data. The pragmatic default.
4. **Your own v2 scorer** — the endgame, once it exists and is validated.

### 7.6 Tooling on the chosen stack

- **Cloudflare Cron Triggers** — scheduled Workers, free tier includes them. This is the one place a cron is genuinely warranted.
- **Workers AI** — free-tier embedding and small-model inference, in-stack.
- **Vectorize** — vector storage with a free tier, for §8 stage 3.
- **HTMLRewriter** — Cloudflare-native streaming HTML parser; the correct extraction tool on Workers (Node-based readability libraries won't run there).
- **Browser Rendering API** — for JS-heavy pages that plain fetch can't read. Paid, treat as last resort.

### 7.7 Things to decide when you get there

- Cadence: once daily, or continuous polling with a daily digest?
- What happens on a slow news day — force 5, or allow 2? (Forcing a fixed count guarantees filler.)
- Do auto-added items look different from hand-added ones on the Today page?
- Feedback loop: do your keeps/dismisses adjust source weights automatically, or only when you say so?

---

## 8. V2 as a learning ladder

Since the goal is learning these techniques, this is structured as **five stages that each teach something distinct and each ship working on their own** — rather than one pipeline you either finish or abandon.

### Stage 1 — Heuristic scoring (teaches: feature engineering)
Pure regex and counting over the text. No ML, no dependencies, runs free in a Worker, fully debuggable.

| Signal | How | Why it tracks quality |
|---|---|---|
| Specificity density | Numbers, dates, named entities per 100 words | Concrete claims vs. vague gesturing |
| Primary-source linking | Outbound links to papers/filings vs. to other news | 12 links to studies is different work than 0 |
| Hype ratio | "revolutionary," "game-changing," "could," "may" against concrete-claim count | High hype + low specifics = churn |
| Original vs. aggregation | Does it cite another news article as its primary source? | Reporting vs. rewriting |
| Structural markers | Methodology sections, data tables, charts | Study vs. take |

### Stage 2 — The dumb baseline (teaches: why baselines matter)
Keep-rate per source. Literally `kept / total` grouped by publication, as a ranking.

Build this second **specifically so everything later has something to beat.** The lesson is that this simple statistic is embarrassingly hard to outperform, and knowing that number prevents you from believing a fancier model works when it doesn't.

### Stage 3 — Embeddings and similarity (teaches: vector search, chunking)
Chunk article bodies, embed via Workers AI, store in Vectorize, score new items by similarity to the centroid of your starred set. This is the chunking you had in mind, and it's where "semantic search over my archive" falls out as a free bonus feature.

### Stage 4 — A trained classifier (teaches: evaluation, class imbalance, overfitting)
Train on your accumulated keep/dismiss labels using stage 1+2+3 outputs as features. With ~1,800 examples/year at maybe 20% positive, you will meet class imbalance, overfitting, and the limits of small data first-hand. That *is* the lesson — this stage teaches more by being hard than by working.

### Stage 5 — Honest evaluation (teaches: the thing most people skip)
Hide the score, triage blind for a period, then compare your decisions against predictions. Without this you'll anchor on the score, keep high-scored things *because* they're high-scored, and the system will validate itself while learning nothing.

### Two rules to hold regardless of stage

**The score sorts, it never filters.** No auto-hiding. A system that hides things builds a filter bubble you cannot detect, because the evidence it's wrong is exactly what it withheld.

**The score must be explainable in one line.** "82 — high specificity, source you keep 70% of the time, close to 4 things you starred." An unexplained number gets ignored within a week, because when it's wrong you can't tell if it's wrong *this time* or wrong *generally*.

---

## 9. Fresh-eyes critique

Re-reading sections 1–8 cold.

### 9.1 V1 still has no discovery, and that's now a deliberate bet
V1's only ingestion is you pasting things in, with automation deferred to §7. That's a defensible call now that it's explicit — but it means **the Today page is empty every day until you or a chat session feeds it.** The entire Today/Pending/lapse apparatus is machinery for a page that starts empty. If the manual habit doesn't hold for two weeks, the app dies and the cause won't be the design, it'll be the empty page. Worth deciding in advance what "it's working" looks like, so you notice the failure early rather than drifting away from it.

### 9.2 The learning framing resolves the cost-benefit objection but creates a different one
Naming v2 a learning project is the right call and it defuses my earlier complaint. But it introduces a scope risk in the other direction: **learning projects have no natural stopping point.** There's always another technique. The ladder in §8 helps because each stage ships, but be honest that stage 4 exists to teach rather than to work — if you evaluate it as a feature it will disappoint, and if you evaluate it as a lesson it'll succeed.

### 9.3 Stage 1 may work well enough to block the actual learning
Real risk: heuristic scoring (stage 1) plus source keep-rate (stage 2) produces something decent, at which point stages 3–5 have no *practical* justification and get skipped. Since the point is learning, that's the failure case. If it happens, do stage 3 anyway on the explicit grounds that you're not building a product. That's a legitimate reason and it should be pre-authorized so it doesn't feel like waste in the moment.

### 9.4 §2.6 and §4 still contradict each other
Deriving lapse at query time (§2.6) means it never *happens* at a point in time — so it generates no event, and §8's stage 2/4 want lapse as a weak negative label. Resolution: derive Today/Pending at query time (that part is clean), but make lapse a recorded transition, written lazily the first time a query notices an item aged past the window. Keeps "no cron" nearly true and still produces the event. Decide this deliberately rather than discovering in month three that you have no lapse history.

### 9.5 arXiv PDFs remain unhandled
Sections 3 and 8 assume HTML throughout, but a large share of primary AI research is arXiv PDFs — and §8 stage 1's structural signals (methodology sections, data tables) are *most* meaningful exactly where the HTML parser doesn't work. §7.2 lists the arXiv API for metadata, which doesn't solve body extraction. PDF text extraction is a distinct code path neither document accounts for, and given you specifically want studies, it's not an edge case.

### 9.6 The newsletter trick has a maintenance tail
§7.3 is the highest-leverage idea in this document and also the most fragile. Newsletter HTML changes without warning, links get wrapped in tracking redirects that need unwrapping, and **parsers fail silently** — you won't get an error, you'll just quietly stop receiving articles and might not notice for a week. If you build it, build a canary: alert when a source that normally yields links yields zero.

### 9.7 "Capture greedily" deserves one caveat
§5.3 is right that unrecoverable data is the real risk, but taken literally it justifies hoarding anything. The honest boundary: capture greedily what's **cheap and irreplaceable** (text, HTML, timestamps, events). Don't capture what's expensive and reproducible — screenshots, generated audio, derived scores. Those can be regenerated from the raw material, which is the whole point of keeping it.

### 9.8 The planning-to-building ratio is now genuinely bad
Fourth document, still no code. This is the critique I'd most stand behind. The specification is more enjoyable to produce than the app, it never crashes, and it can always be improved — which is exactly what makes it a trap.

Most of sections 2, 5, and 8 are hypotheses about your own behavior that **two weeks of using an ugly version would settle better than any further design.** Build the weekend version: paste a URL, see a list, star, archive, search. Use it. Let real usage set the lapse window, decide whether Pending earns a page, and tell you whether you ever actually wanted a score.

---

## 10. Open questions

1. **Two surfaces or three?** (§2.2 vs. §9.1 — does Pending earn its own page, or become a strip on Today?)
2. **PDF support in v1 or v2?** (§9.5 — matters more than it looks, given you read papers.)
3. **Lapse window default** — 14 days, or shorter to keep pressure on?
4. Lapse as derived state or recorded event? (§9.4 — recommend recorded.)
5. When automation comes: is the newsletter route (§7.3) the first thing to try, or straight to RSS + LLM triage?
