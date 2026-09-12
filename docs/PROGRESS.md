# NeatInfo — V1 Hardening Round

**Status:** Phases 0, 1, 2 and 3 complete on branch `v1-hardening` (not pushed, not deployed). V1-02 left for the user -- the token must be revoked in the Cloudflare dashboard before `secrets.md` is emptied. V1-05's commit half is done; the deploy has not been run. `npm test` is green with 231 tests across 13 files. Phase 4 is next.
**Date:** 2026-09-10
**Authority:** `NeatInfo_Design_Report.md` §3 defines scope. This file is an execution list, not a fifth design document (§9.8).

---

## Goal

V1 is roughly 75% built and has never been tested. This round closes the remaining gaps against Design Report §3 and makes what exists trustworthy: fix the two latent bugs that will make the app look broken in normal use (a session-cookie regex that fails whenever another cookie precedes it, and an FTS query that 500s on ordinary punctuation), finish the one genuinely missing §3 feature (Archive filters — date range, source, tag, status, favorite, which the feed endpoint does not support at all), close the "never a dead end" hole where a failed fetch cannot afterwards be filled in by pasting text, and stand up a small test suite so the next change does not silently break the archive. No V2 scoring, no §7 auto-curation, no new surfaces.

**Definition of done:** every bullet in Design Report §3 is reachable from the UI and exercised by at least one test; `npm test` passes; the app can be used for two weeks without an unexplained failure; the legacy pre-React frontend is deleted; the leaked Cloudflare token is rotated.

---

## Success criteria

Concrete and checkable. All must be true at the end of the round.

1. `npm test` exists, runs under `@cloudflare/vitest-pool-workers` against a real local D1 with `schema.sql` applied, and passes with **≥ 35 tests**.
2. **Every §3 "Store" filter — date range, source, tag, status, favorite — is a query parameter on `/api/feed`, is reachable from the Archive UI without typing, and has a worker test.**
3. A regression test asserts `isAuthed` succeeds for a `Cookie` header where `neatinfo_session` is **not** the first cookie (today it fails).
4. A property/table test feeds ≥ 12 hostile search strings (`gpt (4)`, `cost-benefit`, `title:x`, `"`, `***`, `AND`, `a NEAR b`, empty) through search and **none returns a 5xx**.
5. No unhandled path in the router returns a 500 for well-formed input; a test enumerates every route × method pair and asserts the status is one of 200/201/400/401/404/405/409.
6. An article whose fetch failed can be completed in-app by pasting title/source/text, without deleting and re-adding, and a test covers it.
7. Lapse tests: an article at N-1 days is Pending; at N+1 days it is Archived with status `lapsed` and **exactly one** `lapsed` event, and a second feed read adds no further event.
8. Archive shows an honest total and can page past 200 rows; searching with a filter applied returns filtered results, not filtered-page-of-200 results.
9. `public/app.js`, `public/index.html`, `public/styles.css` are deleted; `dist/` contains no file that is not produced by `vite build`; the service worker installs successfully after the deletion.
10. `secrets.md` no longer contains a live credential, and the token in it has been revoked in the Cloudflare dashboard.
11. The client never leaves an unhandled promise rejection: a forced 401 shows the Gate, a forced 500 shows a toast, and neither leaves a blank screen.
12. CI runs `npm test` before `wrangler deploy`, and a failing test blocks the deploy.

---

## Audit summary

**Implemented and working** (verified by reading the code, not the summary):

| §3 item | State |
|---|---|
| Paste URL → fetch, extract title/source/author/date/body | Done (`worker/extract.js`, HTMLRewriter) |
| Paste raw text with manual title/source | Done (`AddSheet.jsx`) |
| Duplicate detection on normalized URL | Done (`worker/url.js`, unique index, 409 + "Open it") |
| Graceful fetch failure creates the item anyway | Done at ingest; **incomplete afterwards** (see gap G6) |
| Today / Pending / Archive computed at read time | Done (`getFeed`), timezone-correct via client `dayStart` |
| Pending All / Opened / Never-opened filter | **Done end to end** (`Pending.jsx` → `?filter=` → server) |
| Card: title, source, date, summary, estimated read time | Done (`helpers.metaLine`, `readMinutes` at 230 wpm) |
| Summary from `og:description` → first 40 words | Done |
| Keep / Star / Dismiss | Done, with events |
| Note field, manual tags | Done (PATCH `/api/articles/:id`) |
| TTS Tier 1 (Web Speech) | Done, with caveats (G8) |
| FTS5 over title/summary/body/notes | Schema + triggers correct; **query builder unsafe** (G2) |
| JSON export | Done |
| Lapse as a recorded event (§9.4) | Done — open question 4 is closed in code |
| Keyboard shortcuts | Already present (`App.jsx`): j/l step, k/s/x resolve |
| PWA manifest, share target, service worker | Present; SW precache list is stale (G10) |

**Data model (§4):** schema matches the report exactly. `event` type CHECK adds `unstarred` (fine). Indexes are sensible. Nothing missing.

---

## Gap table

| # | Gap | Ref | Current state | This round | Size |
|---|---|---|---|---|---|
| G1 | **Session cookie regex is broken.** `` new RegExp(`(?:^|;\s*)...`) `` — `\s` inside a template literal is the literal `s`, so the compiled pattern is `(?:^|;s*)`. Auth fails whenever any cookie precedes `neatinfo_session` (e.g. Cloudflare's `__cf_bm`). Verified by execution. | §1 auth | Broken in production, intermittently | **IN** | S |
| G2 | **FTS query is not escaped.** `q.replace(/["'*]/g,'')+'*'` leaves `(`, `)`, `:`, `^`, `NEAR`, `AND` live. `gpt (4)` → fts5 syntax error → 500. | §3 Store | Unhandled 500 | **IN** | S |
| G3 | **Archive filters absent.** §3 lists date range, source, tag, status, favorite. `/api/feed` accepts only `q`. Starred is filtered client-side over one 200-row page; rail tags are decorative. | §3 Store | Missing | **IN** | L |
| G4 | **Archive is capped at 200 rows, no paging.** "Searchable forever" is false past 200; counts and the Starred surface are wrong beyond that. | §2.2, §3 | Missing | **IN** | M |
| G5 | **No tests of any kind.** No framework, no script, no CI gate. | — | Missing | **IN** | M |
| G6 | **"Never a dead end" only holds at ingest.** After a failed fetch, re-pasting the URL hits the duplicate guard, and PATCH accepts only `notes`/`tags` — there is no way to supply the text. | §3 Pull | Half-implemented | **IN** | M |
| G7 | **Client has no error handling.** `load()`, `resolve()`, `toggleStar()` are called un-awaited/un-caught. A 401 (cookie expires at 90 days) or any 500 yields an unhandled rejection and a frozen or blank screen. | §9.1 (app must not feel broken) | Missing | **IN** | M |
| G8 | **Reader/TTS state is not keyed to the article.** The note `<textarea>` uses `defaultValue` with no `key`, so stepping j/l shows the previous article's note; speech continues after the reader closes; `speechSynthesis` is called inline rather than behind the interface §6 asks for. | §6 | Buggy | **IN** | S |
| G9 | **Legacy vanilla frontend is live.** `public/app.js` (23 KB), `public/index.html`, `public/styles.css` are tracked in git and copied verbatim into `dist/` by Vite, so dead code ships. `src/styles.css` and `public/styles.css` are byte-identical duplicates. | hygiene | Dead code, shipped | **IN** | S |
| G10 | **Service worker precaches files that are about to be deleted** (`/app.js`, `/styles.css`) and never precaches the hashed React bundle. Deleting G9's files makes `addAll` reject and the SW install fail outright. | §1 PWA | Latent break | **IN** | S |
| G11 | **`secrets.md` holds a live Cloudflare API token in plaintext** in the project directory. Gitignored, so not committed — but present on disk and in tool output. | hygiene | Leak | **IN** | S |
| G12 | **R2 `_usage` counter is a read-modify-write** with two `head()` calls per add and no atomicity; concurrent adds lose counts and it only ever increments (deleted objects never subtract). | §5.2 | Inaccurate | **IN** | S |
| G13 | **Raw HTML is captured but unreadable.** No endpoint serves `raw_html_key`, so §5.4's ten-minute "can I actually extract what V2 wants" check cannot be run. | §5.4 | Missing | **IN** | S |
| G14 | **`applyLapses` scans and writes on every feed read** with an unbounded batch. Harmless at 5/day, but there is no cap and no test. | §9.4 | Works, untested | **IN** (test only) | S |
| G15 | **arXiv / PDF bodies unextractable.** `extract.js` correctly refuses non-HTML rather than mangling it, and AddSheet already offers "Behind a login wall, or a PDF? Paste the text instead". Full PDF text extraction is a separate code path. | §9.5, Q2 | Refused cleanly | **PARTIAL** — narrow arXiv slice in, PDF parsing out | S |
| G16 | **Keyboard shortcuts use a non-standard j/l pairing**, and `k` (conventionally "previous") means Keep. No discoverability. | PRD §4 | Present, awkward | **IN** (rebind + help) | S |
| G17 | **Export omits settings and has never been round-tripped.** It is the disaster-recovery story and is untested. Raw HTML in R2 is not covered by it. | §3 Store | Untested | **IN** | S |
| G18 | **Working tree is dirty** (`package.json` wrangler 3→4, `package-lock.json`, `deploy.yml`) and uncommitted; deploy has not been verified since the bump. | hygiene | Unverified | **IN** | S |
| G19 | **`body_text` has no length guard before insertion into D1.** D1 rejects any value over ~1 MB with `D1_ERROR: string or blob too big: SQLITE_TOOBIG`, so a long page (a transcript, a book-length post) 500s at the INSERT and the article is lost outright -- the exact failure §3 "Pull" forbids. Found during Phase 2. | §3 Pull, §5.2 | Unhandled 500, article lost | **IN** | S |

**Judged out (recommendations in "Out of scope"):** PDF text extraction, LLM summaries, ratings, multi-topic UI, digest email, recap/analytics, related articles, browser clipper, TTS Tier 2, any scoring, RSS/newsletter ingestion.

---

## Work breakdown

Ordered for top-to-bottom execution. Phases are groupings, not gates — but Phase 0 and Phase 1 should land before Phase 3, because Phase 3 is the largest change and wants a net under it.

### Phase 0 — Hygiene and safety (do first, ~half a day)

**V1-01 — Fix the session cookie regex.**
Escape `\s` in the template literal in `worker/auth.js`, or replace the regex with a split-based cookie parser.
*Acceptance:* `isAuthed` returns true for `Cookie: __cf_bm=x; neatinfo_session=<valid>` and for the cookie in first position; still false for a tampered or expired token.
*Files:* `worker/auth.js`. *Deps:* none.

**V1-02 — Rotate the leaked Cloudflare token.**
Revoke the token in `secrets.md` in the Cloudflare dashboard, issue a new one, store it only in the GitHub Actions secret `CLOUDFLARE_API_TOKEN`, and replace `secrets.md` contents with a pointer to where secrets actually live.
*Acceptance:* the old token returns 401 from the Cloudflare API; `secrets.md` contains no credential; CI deploy still succeeds.
*Files:* `secrets.md`, GitHub repo settings. *Deps:* none.

**V1-03 — Delete the legacy vanilla frontend.**
Remove `public/app.js`, `public/index.html`, `public/styles.css` (the last is a byte-identical duplicate of `src/styles.css`). Keep the icons, manifest and `sw.js`.
*Acceptance:* `git ls-files public/` lists only icons, manifest, `sw.js`; `npm run build` succeeds; `dist/` contains no `app.js`; the app loads.
*Files:* `public/*`. *Deps:* V1-04 must land in the same commit.

**V1-04 — Repair the service worker precache.**
Replace the hardcoded `SHELL` list with `['/', '/manifest.webmanifest', '/icon.svg']` plus runtime caching of the hashed bundle (or generate the list at build time). Bump `CACHE` to `v2`.
*Acceptance:* SW installs without error after V1-03; loading offline after one online visit renders the shell rather than the browser error page; `/api/*` is still never cached.
*Files:* `public/sw.js`. *Deps:* V1-03.

**V1-05 — Clean and verify the working tree.**
Commit the wrangler 3→4 bump, `package-lock.json` and the `deploy.yml` change; run a real deploy and confirm the site serves.
*Acceptance:* `git status` clean; a deploy from `main` succeeds; the deployed app authenticates and lists the feed.
*Files:* `package.json`, `package-lock.json`, `.github/workflows/deploy.yml`. *Deps:* V1-01, V1-03, V1-04.

### Phase 1 — Test harness (the net)

**V1-06 — Stand up Vitest with the Workers pool.**
Add `vitest`, `@cloudflare/vitest-pool-workers`, a `vitest.config.js` binding D1 and R2 from `wrangler.toml`, a helper that applies `schema.sql` to a fresh DB per test file, and `"test": "vitest run"` / `"test:watch": "vitest"` scripts.
*Acceptance:* `npm test` runs and passes with one trivial smoke test that inserts an article and reads it back.
*Files:* `package.json`, `vitest.config.js`, `test/helpers.js`. *Deps:* V1-05.

**V1-07 — Pure-function unit tests.**
`normalizeUrl` (utm/ref/fbclid stripping, `www.` removal, trailing slash, param sort, `http→https`, non-http rejection, garbage input), `sourceFromUrl`, `countWords`, `summarizeText`, `readMinutes`/`metaLine`/`lapseInfo` from `src/helpers.js`.
*Acceptance:* ≥ 15 assertions; two normalized-equal URL pairs prove duplicate detection catches them.
*Files:* `test/url.test.js`, `test/extract.test.js`, `test/helpers.test.js`. *Deps:* V1-06.

**V1-08 — Auth and router tests.**
Session POST/GET/DELETE; the G1 cookie-ordering regression; expired token; tampered signature; unauthenticated access to every `/api/*` route returns 401; every route × method pair returns a status in {200,201,400,401,404,405,409}.
*Acceptance:* success criteria 3 and 5 are met.
*Files:* `test/auth.test.js`, `test/router.test.js`. *Deps:* V1-06.

**V1-09 — Surface and lapse tests.**
Feed with a seeded fixture: an item added today is in `today`; one added yesterday is in `pending`; `filter=opened|unopened` partitions correctly and `pendingTotal` stays unfiltered; lapse boundary at N-1 / N+1 days; exactly one `lapsed` event; a second read is a no-op.
*Acceptance:* success criterion 7 met; ≥ 8 tests.
*Files:* `test/feed.test.js`. *Deps:* V1-06.

**V1-10 — Ingest tests.**
URL add with a stubbed `fetch` (happy path, 404, non-HTML content type, network throw); pasted-text add; duplicate returns 409 with the existing article; title/source fallbacks; `added` event written; R2 put skipped when over the per-file cap.
*Acceptance:* ≥ 8 tests, including one asserting a failed fetch still yields a 201 with a usable row.
*Files:* `test/ingest.test.js`. *Deps:* V1-06.

### Phase 2 — Correctness bugs

**V1-11 — Sanitize FTS queries.**
Replace the `replace(/["'*]/g,'')` hack with a tokenizer: split on non-word characters, drop empties, wrap each token in double quotes, append `*` to the final token, and return the unfiltered archive when nothing survives.
*Acceptance:* success criterion 4 met; `cost-benefit` and `gpt (4)` return sensible results; a search matching nothing returns an empty list, not an error.
*Files:* `worker/index.js` (new `worker/search.js` if it grows), `test/search.test.js`. *Deps:* V1-06.

**V1-12 — Client-side error handling.**
Centralise in `api.js`: a 401 clears auth state and shows the Gate; any other failure surfaces a toast. Wrap `load`, `resolve`, `toggleStar`, `saveNote` so no promise is left unhandled. Add a top-level React error boundary.
*Acceptance:* success criterion 11 met, verified manually against a stubbed 401 and 500.
*Files:* `src/api.js`, `src/AppContext.jsx`, `src/App.jsx`, new `src/components/ErrorBoundary.jsx`. *Deps:* none.

**V1-13 — Key the Reader to the article; tame TTS.**
Add `key={a.id}` to the reader body (or drive the note from state on article change), move `speechSynthesis` behind a tiny `speak/pause/stop` module so §6's Tier 2 swap needs no UI change, and call `stop()` on close and on article change. Chunk long text to dodge Chrome's silence-after-~15s bug.
*Acceptance:* stepping j/l shows the correct note every time; closing the reader stops speech; a 5,000-word article plays to the end in Chrome.
*Files:* `src/components/Reader.jsx`, `src/components/TtsPlayer.jsx`, new `src/tts.js`. *Deps:* none.

**V1-14 — Close the "never a dead end" hole.**
Extend `PATCH /api/articles/:id` to accept `title`, `source`, `body_text` (recomputing `word_count`, `summary` when empty, and `fetch_status='pasted'`), and add a `POST /api/articles/:id/refetch`. In `AddSheet`, when a 409 comes back for an article with a failed `fetch_status`, offer "paste the text into the existing item" instead of only "Open it".
*Acceptance:* success criterion 6 met; a test patches body text onto a failed-fetch row and asserts FTS then finds it.
*Files:* `worker/index.js`, `src/components/AddSheet.jsx`, `src/components/Reader.jsx`, `test/ingest.test.js`. *Deps:* V1-06.

**V1-26 — Cap `body_text` before it reaches D1.**
Truncate extracted and pasted body text to a byte cap at ingest, recompute `word_count` from what is stored, mark the cut in the text itself, and report it to the client. Apply the same cap on V1-14's PATCH path and on refetch. The raw HTML is already in R2, so nothing that matters is lost.
*Acceptance:* adding an article whose body is over the cap returns 201 with a usable, searchable row rather than a 500; a test covers the ingest and the PATCH paths.
*Files:* `worker/extract.js`, `worker/index.js`, `src/AppContext.jsx`, `src/components/AddSheet.jsx`, `test/truncate.test.js`. *Deps:* V1-14.

### Phase 3 — §3 "Store" filters (the largest real gap)

**V1-15 — Add filter parameters to the archive query.**
Extend `/api/feed` (or split out `GET /api/archive`) to accept `status`, `favorite`, `source`, `tag`, `from`, `to`, `limit`, `offset`, composable with `q`. Build the SQL with bound parameters only. Return a filtered total alongside the rows.
*Acceptance:* success criterion 2's server half; a test per filter plus one combining `tag` + `from/to` + `q`.
*Files:* `worker/index.js`, `test/archive.test.js`. *Deps:* V1-11.

**V1-16 — Facets endpoint.**
`GET /api/facets` returning distinct sources and tags with counts, plus the earliest `added_at`, so the filter UI needs no client-side scan of a partial page.
*Acceptance:* returns counts that match a direct SQL count in a test; responds in one round trip.
*Files:* `worker/index.js`, `test/archive.test.js`. *Deps:* V1-15.

**V1-17 — Archive filter bar UI.**
A compact control row above the search box: status chips (kept / dismissed / lapsed / all), a favorite toggle, a source `<select>`, a tag `<select>`, and two date inputs. Filters live in `AppContext` and are passed to `load()`. Make the rail tags clickable to set the tag filter. Show "N of M, filtered by …" with a one-click clear.
*Acceptance:* success criterion 2's UI half; every filter is reachable without typing; Starred becomes `favorite=1` server-side rather than a client filter.
*Files:* `src/components/Archive.jsx`, `src/AppContext.jsx`, `src/App.jsx`, `src/styles.css`. *Deps:* V1-15, V1-16.

**V1-18 — Archive paging.**
Replace the hardcoded `LIMIT 200` with `limit`/`offset` plus a "Load more" button, and make the displayed total the filtered server count.
*Acceptance:* success criterion 8 met; a test seeds 250 rows and asserts page 2 returns the correct slice and the total reads 250.
*Files:* `worker/index.js`, `src/components/Archive.jsx`. *Deps:* V1-15.

### Phase 4 — Polish, robustness, close-out

**V1-19 — Fix the R2 usage accounting.**
Drop the per-write `_usage` counter. Compute usage on demand in `GET /api/settings` by paging `RAW.list()` and summing sizes (cached in `setting` with a timestamp if it gets slow), and do one `head()`-free budget check per add.
*Acceptance:* adding an article performs at most one extra R2 operation; the settings figure matches a manual `wrangler r2 object list` sum; concurrent adds cannot corrupt the number.
*Files:* `worker/index.js`. *Deps:* none.

**V1-20 — Raw HTML read endpoint plus the §5.4 validation script.**
`GET /api/articles/:id/raw` streaming the R2 object (404 when `raw_html_key` is null), and a throwaway `scripts/validate-capture.mjs` that walks the export, pulls raw HTML, and reports outbound-link counts, numeric density and clean-chunk sizes.
*Acceptance:* the script runs over the current archive and prints a table; §5.4's ten-minute check is actually performable.
*Files:* `worker/index.js`, `scripts/validate-capture.mjs`. *Deps:* V1-05.

**V1-21 — Narrow arXiv slice** *(pending decision D1 — see Risks)*.
When a URL matches `arxiv.org/(abs|pdf)/<id>`, normalize to the `/abs/` page and extract title, authors, date and abstract from it. No PDF parsing.
*Acceptance:* pasting an arXiv PDF link creates a fully populated item with the abstract as body text and `fetch_status='ok'`; a test covers both URL shapes.
*Files:* `worker/url.js`, `worker/extract.js`, `test/extract.test.js`. *Deps:* V1-07.

**V1-22 — Keyboard shortcuts: rebind and document** *(pending decision D2)*.
Move to `j`/`k` for next/previous, `e` keep, `s` star, `x` dismiss, `a` add, `/` focus search, `?` toggle a help overlay, `Esc` close. Update the `keyhint` strip.
*Acceptance:* every shortcut works from Today, Pending and Archive; none fires while typing in an input; `?` lists them all.
*Files:* `src/App.jsx`, `src/components/Reader.jsx`, new `src/components/Shortcuts.jsx`. *Deps:* V1-12.

**V1-23 — Empty, loading and error state pass.**
Give every surface an honest empty state (Today already has one; Pending's is generic; Archive has none, and none distinguishes "no results for this filter" from "nothing archived yet"). Add a loading state to the initial feed fetch and to search.
*Acceptance:* each of Today / Pending / Archive / Starred renders a specific, non-alarming message when empty; no surface ever shows a bare blank area.
*Files:* `src/components/{Today,Pending,Archive}.jsx`, `src/styles.css`. *Deps:* V1-12.

**V1-24 — Export round-trip and completeness.**
Include the `setting` table and a `raw_html_keys` list in the export payload; write a test that exports a seeded DB, re-imports it into a fresh one via a small `scripts/import.mjs`, and asserts row-for-row equality.
*Acceptance:* success criterion for §3 "Store" export; the round-trip test passes.
*Files:* `worker/index.js`, `scripts/import.mjs`, `test/export.test.js`. *Deps:* V1-06.

**V1-25 — Gate CI on tests, then final acceptance pass.**
Insert `npm test` before the build step in `deploy.yml`, refresh `README.md` to describe the current React app (it predates the rewrite), and walk the §3 checklist against the deployed app.
*Acceptance:* success criterion 12 met; a deliberately broken test blocks a deploy; every §3 bullet is ticked against production.
*Files:* `.github/workflows/deploy.yml`, `README.md`. *Deps:* all above.

**V1-30 — HTML entities reach the UI undecoded.**
`el.getAttribute('content')` returns attribute values raw, so every field taken
from a `<meta>` tag keeps its entities while body text (collected through text
handlers) does not. Production carries 5 such titles and 6 summaries.

*Steps:*
1. `decodeEntities()` in `worker/extract.js` — the five named entities that
   occur, plus `&#NN;` and `&#xNN;`. Ampersand last, so `&amp;#39;` cannot
   double-decode into an apostrophe.
2. Apply it in `Meta.element()` to every `content` value.
3. Apply it in `ArxivMeta.element()` likewise.
4. Confirm decoding precedes `summarizeText()` and `truncateBodyText()`, so a
   cap cannot cut an entity in half.
5. Unit tests: named, numeric, hex, unknown entity left alone, bare `&` left
   alone, no-entity passthrough, double-encoding.
6. Integration test through ingest: a page whose `og:title` and
   `og:description` carry entities produces a clean row.
7. **D8** — `PATCH /api/articles/:id` accepts an explicit `summary`, added as a
   new field. The existing "only fill an empty summary" guard on the
   paste/refetch path stays exactly as it is.
8. Test both halves of D8: explicit summary overwrites; a pasted body still
   defers to a summary that is already there.
9. `scripts/repair-entities.mjs` — decodes stored titles and summaries through
   the API. Dry-run by default, `--apply` to write, reports each change.
10. Verify the repair against local data. **Running it against production is
    the user's to do** (decided 2026-09-11).

*Acceptance:* no row created after this carries an entity in title, summary,
source, author **or body**; the repair script's dry run lists exactly what it
would change. The first estimate of 11 affected rows was wrong twice over --
bodies were affected too (26 of 45), and the audit regex mirrored the decoder's
own blind spot, so named entities it did not handle were not even counted. The
measured figure is **30 of 56**.
*Files:* `worker/extract.js`, `worker/index.js`, `scripts/repair-entities.mjs`,
`test/extract.test.js`, `test/ingest.test.js`. *Deps:* none.

**V1-31 — TTS stops after about fifteen seconds.**
`src/tts.js` chunks at 220 characters to dodge Chrome's limit, on the stated
premise that the limit applies to a single utterance. It does not — it applies
to total time spent speaking, so a queue of short utterances stalls just the
same. `end` never fires, `speakNext()` waits on it forever, and nothing is
reported.

*Steps:*
1. Heartbeat inside `webSpeechEngine`: `resume()` every 14s while speaking.
   It belongs in the engine, not the player — Tier 2 must not inherit a Web
   Speech quirk.
2. Clear it on `end`, on `error`, and on `cancel()`, so a stopped article
   leaves no timer poking a dead synth.
3. Correct the `CHUNK_CHARS` comment, which records the wrong premise and would
   otherwise teach the next reader the same mistake.
4. Watchdog: if neither `boundary` nor `end` arrives within a generous multiple
   of a chunk's expected duration, fail loudly through `onError` instead of
   sitting in `playing`.
5. Tests against the existing fake engine: heartbeat fires on schedule, is
   cleared by each of the three exits, the watchdog trips on silence and does
   not trip during normal playback, and the existing chunk/progress tests still
   pass.
6. Confirm in a real browser on a long article — the one part no test covers.

*Acceptance:* an article of several thousand words plays to the end in Chrome;
a stalled engine produces a visible error rather than silence. **Step 6 is not
done** -- no automated test can cover it, and it is the step that would have
caught the heartbeat being restarted on every chunk. While doing it, settle
whether Chrome's limit is per-utterance or cumulative: speak one 60s utterance
with the heartbeat disabled, then twenty 3s ones, and see which dies.
*Files:* `src/tts.js`, `test/tts.test.js`. *Deps:* none.

**V1-32 — Tier 2 speech: MeloTTS, generated on demand, nothing stored.**
§6 kept the player behind `speak / pause / resume / stop` so this could drop in.
Measured before designing, and the documentation was wrong in a way that
mattered: `@cf/myshell-ai/melotts` returns `{audio: "<base64>"}` wrapping
44.1kHz 16-bit mono **WAV**, not the MP3 the docs claim. That is 88 KB per
second of audio -- 252 MB for a p90 article -- so **D7 is reversed: nothing is
cached in R2.** §9.7 says as much anyway: capture what is cheap and
irreplaceable, and generated audio is neither.

Instead the Worker generates ~60 seconds at a time, as you listen. Neurons are
a non-issue (~890 for a 48-minute article against 10,000 a day); bandwidth is
the cost, and it is only paid for audio actually played.

*Steps:*
1. `[ai] binding = "AI"` in `wrangler.toml`, and note in `.dev.vars.example`
   that Workers AI always runs remotely, even under `wrangler dev`.
2. `segmentText()` in `worker/speech.js` -- pure, paragraph-aware, ~800
   characters a segment, so a segment is roughly a minute of audio and one
   AI call.
3. `GET /api/articles/:id/audio` -- the manifest: segment count and total
   characters, so the client knows how many parts there are without holding
   the text.
4. `GET /api/articles/:id/audio/:seg` -- generates that segment and returns
   `audio/wav`. No R2 write. A segment out of range is a 404, not an empty
   200.
5. Guard the budget: refuse generation above a per-article ceiling and report
   it, so one 48-minute paper cannot quietly eat the day's neurons.
6. Worker tests with `env.AI` stubbed -- manifest arithmetic, range handling,
   content type, and that nothing is written to R2.
7. `workersAudioEngine` in `src/tts.js`: plays segments in order through one
   `<audio>` element, exposing the same `speak / pause / resume / cancel /
   available` the Web Speech engine does.
8. Extend the player seam minimally: an engine may supply its own units via
   `prepare()`, since Tier 2's are server-side segments rather than client-side
   chunks. Tier 1 keeps using `chunkText`.
9. Media Session metadata -- title, source -- which is what makes the lock
   screen work on iOS, and the actual reason for the tier.
10. Fall back to Tier 1 when the server has no AI binding or a segment fails.
    Speech that works offline with no account is worth keeping as the floor.
11. Client tests against a fake `<audio>` element, in the style of the existing
    fake engine.

*Acceptance:* a long article plays end to end through server audio, sounds the
same on every device, survives a locked screen, writes nothing to R2, and falls
back to the browser voice when Workers AI is unavailable.
*Files:* `wrangler.toml`, `worker/speech.js`, `worker/index.js`, `src/tts.js`,
`src/components/TtsPlayer.jsx`, `test/speech.test.js`, `test/tts.test.js`.
*Deps:* V1-31.

**V1-33 — Stage 1 of §8's ladder: heuristic features over what is already stored.**
Pure counting -- no AI call, no embeddings, no labels required. It is the only
stage buildable today: measured against the live archive, there is **1 keep and
0 dismissals**, so Stages 2 and 4 have nothing to learn from. Stage 1 produces
exactly the features Stage 4 will train on when there are labels, so it is not
throwaway work.

Python, in `pipeline/`, run nightly from GitHub Actions. Not a Worker: the
feature pass loops over megabytes of text, and the free plan allows 10ms of CPU
per invocation -- the lesson V1-32 learned the expensive way, where a decode
loop measured 14ms and `wrangler dev` could never have shown it.

*Steps:*
1. `article_feature` table plus a migration: `article_id`, `version`,
   `computed_at`, `score`, and a JSON `payload`. Unique on
   (`article_id`, `version`) so re-running a changed extractor adds a row
   rather than overwriting one -- old and new scores must never be silently
   compared, and Stage 5 needs both.
2. Two keyed endpoints beside the candidate ones, using the same
   `DISCOVER_KEY` header rather than a second secret: `GET /api/pipeline/work`
   (articles needing features at the current version) and
   `POST /api/pipeline/features` (batch upsert).
3. The canary. Record `pipeline_last_run` and `pipeline_last_count` in
   `setting`, surface both in `/api/settings`, and say so in the UI. A nightly
   job that quietly stops is invisible for a week -- §9.6, and the failure mode
   this session has hit twice.
4. `pipeline/features.py` -- the counting, with every signal from §8 Stage 1:
   specificity density (numbers, dates, an entity proxy), hype-to-concrete
   ratio, outbound primary-source link ratio, original-vs-aggregation, and
   structural markers. Raw HTML comes from `/api/articles/:id/raw`; body text
   from the work endpoint.
5. One headline `score`, and an `explain` string that states the reason in one
   line. §8's rule: an unexplained number gets ignored within a week, because
   when it is wrong you cannot tell whether it is wrong this time or generally.
6. `pipeline/client.py` -- pull, compute, push, resumable and idempotent. It
   will be interrupted; a second run must be a no-op, not a duplicate.
7. `pytest` over `features.py` with fixtures that are real article shapes: a
   paper abstract, a press release, an aggregator rewrite. Assert the ordering
   between them rather than absolute numbers, which are arbitrary.
8. Worker tests for both endpoints -- auth, batching, the version constraint,
   and that the canary actually moves.
9. `.github/workflows/pipeline.yml` -- nightly, `setup-python` with pip
   caching. Docker only when spaCy arrives and there is a model worth baking
   into an image.
10. `pipeline/README.md` in the style of `scripts/README.md`: what each signal
    means, why it is a proxy, and what would disprove it.

*Acceptance:* every article with text has a feature row; the same run twice
changes nothing; Settings shows when the pipeline last ran; and the scores can
be read down a list with the explanation making sense next to each one.

**Deliberately not in scope:** any use of the score. It is computed and stored,
not applied. §8's other rule -- the score sorts, it never filters -- and there
is nothing yet to say it is any good. Stage 5 decides that, after labels.
*Files:* `schema.sql`, `migrations/`, `worker/index.js`, `pipeline/*`,
`test/pipeline.test.js`, `.github/workflows/pipeline.yml`,
`src/components/SettingsSheet.jsx`. *Deps:* V1-28.

---

## Checklist

**Phase 0 — hygiene and safety**
- [x] V1-01 Fix the session cookie regex (`\s` swallowed by the template literal)
- [ ] V1-02 Rotate the leaked Cloudflare API token
- [x] V1-03 Delete the legacy vanilla frontend from `public/`
- [x] V1-04 Repair the service worker precache list
- [ ] V1-05 Commit the wrangler 4 bump and verify a real deploy **(root cause found: the
  GitHub Actions deploy has never succeeded. Both runs on `main` fail at "Apply D1
  migrations" while tests and build pass, and the same command succeeds locally against
  the same database with OAuth credentials -- so the `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` repo secrets are unset, wrong or expired. Fix it together with
  V1-02: rotate the token, put the new one in the repo secrets, delete the old one.)**

**Phase 1 — test harness**
- [x] V1-06 Stand up Vitest + `@cloudflare/vitest-pool-workers`
- [x] V1-07 Unit tests for URL normalization, extraction and helpers
- [x] V1-08 Auth and router tests (incl. the cookie-ordering regression)
- [x] V1-09 Surface and lapse tests
- [x] V1-10 Ingest tests with a stubbed fetch

**Phase 2 — correctness bugs**
- [x] V1-11 Sanitize FTS queries
- [x] V1-12 Client-side error handling and error boundary
- [x] V1-13 Key the Reader to the article; put TTS behind an interface
- [x] V1-14 Let a failed-fetch article be completed by pasting text
- [x] V1-26 Cap `body_text` before it reaches D1 (SQLITE_TOOBIG)
- [x] V1-27 Chunk the lapse batch *(uncommitted; 50 rows / 100 statements per batch)*

**Phase 3 — §3 "Store" filters**
- [x] V1-15 Filter parameters on the archive query
- [x] V1-16 Facets endpoint (sources, tags, date floor)
- [x] V1-17 Archive filter bar UI
- [x] V1-18 Archive paging and honest totals

**Phase 7 — the V2 pipeline** *(see `NeatInfo_Pipeline_and_Playback_Report.md` §4)*
- [x] V1-33 Stage 1: heuristic features, in Python, nightly *(needs the `pipeline.yml` secrets to run in CI)*

**Phase 6 — Tier 2 speech** *(see `NeatInfo_Pipeline_and_Playback_Report.md` §3)*
- [x] V1-32 Server-generated speech, on demand, nothing stored *(D7 reversed: nothing cached; D9 moot)*

**Phase 5 — defects found in use** *(see `NeatInfo_Pipeline_and_Playback_Report.md`)*
- [x] V1-30 Decode HTML entities everywhere extraction produces text, and widen `PATCH` to repair them
- [x] V1-31 Keep Chrome speaking past 15 seconds, and notice when it stops

**Phase 4 — polish and close-out**
- [x] V1-19 Fix R2 usage accounting
- [x] V1-20 Raw HTML endpoint and the §5.4 validation script
- [x] V1-21 Narrow arXiv slice *(decision D1 taken: the narrow slice, no PDF parsing)*
- [x] V1-22 Rebind and document keyboard shortcuts *(decision D2 taken: in, as a fix)*
- [x] V1-23 Empty, loading and error state pass
- [x] V1-24 Export round-trip and completeness
- [ ] V1-25 Gate CI on tests, refresh README, final §3 acceptance pass **(CI gate and README done; the §3 walk needs a live deploy)**

**27 tasks.**

---

## Risks and open decisions

**D1 — arXiv: narrow slice or nothing?** (§9.5, open question 2)
*Recommendation: build the narrow slice (V1-21), skip PDF text extraction.* The report is right that papers are not an edge case for you, but PDF parsing on Workers means shipping a WASM parser or paying for Browser Rendering — days of work for a code path §8 does not need yet. arXiv's `/abs/` page is plain HTML with title, authors, date and the full abstract, and `arxiv.org/pdf/x` maps to it by rewriting one path segment. That is an hour and covers most of what you paste. Full-text extraction is a V2 concern, and the paste-text path already exists as the manual fallback. **If you disagree, say so before V1-21 — it is the only task with a real alternative.**

**D2 — Keyboard shortcuts: in or out?** (PRD §4 vs. §3's boundary)
*Recommendation: in, as a fix rather than a feature.* They already exist, so the §3 boundary argument is moot — the question is only whether to leave `j`/`l` (non-standard) and `k`-means-Keep (collides with every reader app's "previous"). Rebinding is 30 minutes and it is cheaper now than after two weeks of muscle memory.

**D3 — Two surfaces or three?** (open question 1)
*Recommendation: no decision now; leave it at three.* All three are built and working. This is precisely the question §9.8 says two weeks of usage answers better than more design. Revisit after the round, with the honest test being: how often did you open Pending?

**D4 — Lapse window default.** (open question 3)
*Recommendation: no decision needed.* 14 days is implemented and is a setting. Fiddling with it now is §2.4's "procrastination disguised as configuration".

**D5 — Lapse: derived or recorded?** (open question 4)
*Closed.* Already implemented as a recorded transition per §9.4. No action.

**D6 — Automation route.** (open question 5)
*Out of scope.* Do not decide it this round; it is §7 and depends on the V2 scorer existing.

**Risk — the empty-page failure (§9.1).** The real threat to V1 is not a bug, it is that Today is empty every day and you drift away. Nothing in this plan addresses that, and nothing should — it is a usage question. *Suggested measurement, no code:* after the round, record for two weeks how many days you added anything. If it is under 7 of 14, the manual-ingest bet has failed and §7 automation moves up the queue ahead of any V2 work.

**Risk — Phase 3 is most of the round's effort** and is the one part touching both worker SQL and UI at once. If time runs short, ship V1-15 + V1-17 (filters reachable) and defer V1-16 + V1-18 (facets, paging) — with under 200 archived articles the cap is not yet a real constraint.

**Risk — the importer restates the article column list.** `worker/importer.js` hardcodes the columns it inserts, while `exportAll` selects `*`. A column added to `schema.sql` later will therefore export but not import, silently. The round-trip test catches it only if a seeded row sets that column to something other than its default, so a schema change should come with a seeded value in `test/export.test.js`.

**Risk — the leaked token may already be compromised.** It sat in a plaintext file in the project directory. V1-02 is first for that reason; treat the rotation as mandatory rather than tidy-up.

---

## Out of scope for this round

Named explicitly so scope creep is visible. Each is either a Design Report §3 exclusion, a §7/§8 item, or a deliberate deferral.

- PDF text extraction (beyond the arXiv abstract slice) — §9.5, deferred to V2
- LLM summaries — §3 "explicitly not v1"
- Ratings / 5-point scale — cut in §2.5
- Multi-topic UI — §1 (`topic_id` stays in the schema, hardcoded to 1)
- Digest emails, recap and analytics views, related-article linking, browser clipper — §3 "explicitly not v1"
- TTS Tier 2 (server-side audio in R2, Media Session API) — §6, gated on confirming you actually listen; V1-13 only makes the swap cheap
- Any scoring, embeddings, Vectorize, Workers AI — §8, all of V2
- RSS / arXiv API / Hacker News / newsletter ingestion, Cron Triggers, clustering — §7
- Multi-user auth, roles, rate limiting, observability tooling — single-user app; §9.8's warning against ceremony
- Migration framework beyond the current idempotent `schema.sql` — no schema change in this round needs one
- Redesign of the visual language — `src/styles.css` is fine; V1-17 and V1-23 add to it, they do not rework it
