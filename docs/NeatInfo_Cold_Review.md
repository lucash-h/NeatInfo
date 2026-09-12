# NeatInfo — independent cold review

*2026-09-12. Written by a reviewer given no history of the project: no
conversation context, no explanation of past decisions, and no knowledge of who
built what or why. The brief was to read the repository, form its own view, and
treat every document in it as a claim to verify rather than as truth.*

*Reproduced verbatim. Four of its factual claims were spot-checked afterwards
and all four held: the broken share target, `pipeline.yml`'s wrong
`working-directory`, the absence of any UI that writes a tag, and the stale
"Known gaps" section in `README.md`.*

---

## Verdict up front

The core is genuinely well built. The state model (Today / Pending / Archive, surfaces derived at read time, lapse as a recorded transition) is the good idea here, it's correctly implemented, and the SQL behind it is careful in ways most personal projects aren't — bind-variable chunking, FTS5 re-tokenisation, a filtered count that matches the filtered rows, byte-accurate truncation. `worker/search.js` and `worker/extract.js` are better than they need to be.

But the project has spent its effort on the parts that were interesting rather than the parts that decide whether it works. Two independent discovery implementations, a Python ML feature pipeline in a second language, three CI workflows, eleven READMEs, seven mermaid diagram files — against a production database that, by the project's own measurement in `docs/PROGRESS.md`, contains **56 articles, 1 keep and 0 dismissals**. The app has essentially never been used. Meanwhile the single most-used mobile ingestion path (the PWA share target) is broken, tags cannot be created from the UI at all, and nothing can ever be deleted.

---

## 1. Is the architecture sound?

**Sound, and the right stack.** One Worker serving both API and assets, D1 for queryable data, R2 for raw HTML, no cron. Read-time surface derivation is the correct call and the reasoning in §2.6 holds up. Passphrase + HMAC cookie is right-sized. The ~7,000 lines of non-test code is not bloated for what's here.

**Over-built, specifically:**

- **`pipeline/` (Python, 478 lines + a nightly CI workflow + a canary + a versioned feature table).** It computes scores nothing reads, over a corpus of 56 articles, to produce training features for a classifier that needs labels the archive does not contain. The code is honest about this — `features.py`'s docstring says so outright. That honesty doesn't make it less premature. It is a second language, a second dependency chain, a second test runner and a third workflow, bought entirely on spec.
- **Two discovery implementations.** `discover/` (RSS + HN Algolia, CI, every 6h, POSTs candidates) and `scripts/gather-candidates.mjs` (TLDR AI + HN + HF papers, local, writes JSON, then `seed-articles.mjs` pushes through the public API). Different sources, different scoring, different ingestion paths, neither tested. One of these should not exist.
- **`discover/url.js` is a hand-copied fork of `worker/url.js` and has already drifted** (it lacks the exported `arxivAbsPath`/`isArxivAbs`, inlines the regex). Both compute `url_normalized`, which is the duplicate key. When they drift further, duplicates appear and nothing will tell you.
- **The tag subsystem.** `article_tag`, the `tag` table, `withTags()` with its 90-bind chunking, the `EXISTS` filter clause, `/api/facets` tag counts, the tag rail in `App.jsx`, the tag `<select>` in `Archive.jsx` — and **no UI anywhere writes a tag.** `PATCH /api/articles/:id` accepts `tags`; nothing in `src/` sends them. The only writer is `scripts/seed-articles.mjs`. Root `README.md` claims `Reader.jsx` is the "detail view: notes, **tags**, fill-in-text, refetch". It isn't. A whole vertical slice of machinery serving a feature the user cannot reach.
- **Documentation volume.** 3,232 lines of Markdown against ~7,000 lines of non-test code, plus ~770 lines of prose comment inside `worker/` and `src/` alone (`src/tts.js`: 179 comment lines in 621; `worker/speech.js`: 54 in 135). The design report's own §9.8 says "the planning-to-building ratio is now genuinely bad" — it was right then and the ratio has since got worse, because eight more Markdown files were added in the last two commits.

**Too thin:**

- **`discover/` has zero tests.** It is the only component that runs unattended, on a schedule, against the open internet, parsing hostile XML with regexes (`discover/rss.js` matches `<item[\s>]...` and reassembles CDATA by hand). The most fragile, least observed code has the least coverage. `test/origin.test.js` tests the Worker's ingest of candidates, not `discover/`.
- **No migration runner.** `migrations/*.sql` are run by hand, once per database, and the deploy workflow's step is *named* "Apply D1 migrations" while running `schema.sql`, which deliberately contains none of them. The name is a lie that will eventually cost someone an afternoon.
- **No delete.** There is no `DELETE` route for an article or a candidate anywhere in `worker/index.js`. A mis-pasted URL is permanent.
- **`decodeEntities` covers ~25 named entities** out of the HTML5 set. Fine as a decision; it's documented. Just noting it's a permanent small tax.

---

## 2. What is genuinely risky — ranked

**1. The live Cloudflare API token is still sitting in plaintext on disk.** `secrets.md` contains `cfat_LtN3...`. `docs/PROGRESS.md` lists V1-02 ("rotate the leaked token") as **unchecked**, dated 2026-09-10, and calls the rotation "mandatory rather than tidy-up". Two days later it's still there. It is gitignored and not in git history (I checked `git log --all -S'cfat_'` — clean), so this is disk-only exposure, but a Cloudflare API token is account-scoped credentials for everything. Revoke it today. It is also the top item on this list only because it's the one with an unbounded blast radius.

**2. Nothing backs up the archive, and the backup path will break before you need it.** `/api/export` builds the entire database as one `JSON.stringify(..., null, 2)` string in Worker memory. At today's 56 articles this is trivial. The design premise is "accumulate for years" — at the ~1,800 articles/year §5.1 sizes for, with `body_text` capped at 512 KB and typically 20–40 KB, the pretty-printed payload crosses the Worker's 128 MB memory ceiling within roughly two years. The disaster-recovery mechanism fails silently at exactly the point the archive becomes worth recovering. And it is manual: a link in the rail that someone has to remember to click. There is no scheduled export anywhere in the repo.

**3. "Keep all" in Discover is broken for any real batch.** `batchResolveCandidates` (`worker/index.js:1161`) loops up to 50 candidates and calls `keepCandidate` for each — one outbound `fetch` plus 2–4 D1 statements plus an R2 `put` apiece. On the free plan every one of those counts against the **50-subrequest-per-invocation** limit. `discover/index.js` posts `BATCH_SIZE = 30`. Thirty keeps is roughly 180 subrequests. It will throw partway, the router's `catch` turns it into a 500, the client toasts "Could not resolve candidates" — and the articles inserted before the throw are already in the database. Partial commit, misleading error, no way to tell what happened. CPU is a second ceiling on the same path: thirty HTMLRewriter extractions in one invocation against a 10 ms budget.

**4. Candidates from old batches become permanently unreachable.** `getCandidates` (`worker/index.js:1062`) selects only the **most recent** pending `batch_id`. The cron runs every 6 hours. Meanwhile `candidate_url_unique ON candidate(url_normalized) WHERE status = 'pending'` plus `INSERT OR IGNORE` means a still-pending candidate from an earlier batch **blocks its own re-insertion** into the new one. So: anything you don't triage within 6 hours is invisible forever, but still counted in the `total` the endpoint returns, and still occupying the unique index so it can never come back. Four batches a day, one review session — you see at most the last 6 hours of discovery and silently lose the rest.

**5. The CI test gate does not gate the deploy that actually happens.** `docs/PROGRESS.md` records that the GitHub Actions deploy **has never succeeded** — both runs on `main` fail at the migration step because the `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` repo secrets are unset or wrong. Production is nevertheless running current code (I confirmed `/api/pipeline/work` returns "Bad or missing pipeline key" on the live URL, so the Worker is at HEAD). That means deploys are happening via `npm run deploy` from the laptop — which is `vite build && wrangler deploy` with **no test run and no schema step**. The elaborate gate in `deploy.yml` is decorative. `README.md` describes the CI path as though it's how the app ships.

**6. `.github/workflows/pipeline.yml` cannot ever have run.** The git root *is* `app/`, but the workflow sets `working-directory: app` and `cache-dependency-path: app/pipeline/requirements.txt`. There is no `app/app/`. So the nightly Stage 1 job fails at the pytest step every night. The irony is sharp: V1-33 built a canary (`pipeline_last_run`/`pipeline_last_count` surfaced in Settings) specifically because "a nightly job that quietly stops is invisible for a week" — and the job has been silently failing since it was written. `discover.yml` has no `working-directory` and is correct, which is how the inconsistency is visible.

**7. Unlimited passphrase attempts on a public URL.** `POST /api/session` has no rate limit, no backoff, no lockout, and the README tells you to "pick anything" for the passphrase. The archive is the project's entire stated value and one guessable string is all that protects it. Free-plan request caps are the only brake, and exhausting them locks *you* out too.

**8. Tier 2 speech ships raw 44.1 kHz WAV to a phone.** `worker/speech.js` documents this clearly — 88 KB/second. An hour of listening is roughly **300 MB of the user's mobile data**. §6's stated motivation for Tier 2 is commute and chore listening. The design note frames bandwidth as a cost to the project (it isn't — Workers egress is free); the cost actually lands on the listener's data plan. No transcoding, no compression, no warning in the UI.

**9. `extractArticle` has no timeout and no response-size limit.** `fetch` with `redirect: 'follow'` and no `AbortSignal`; then `await res.text()` on an unbounded body. A slow origin hangs the add; a very large HTML response buffers into Worker memory before `captureRaw` ever gets to check the 2 MB cap. Low probability, easy fix.

**10. `applyLapses` writes on every feed read, and the FTS triggers amplify it.** Every `UPDATE article` fires `article_au`, which deletes and re-inserts the row's full `body_text` into `article_fts`. So marking an article opened re-indexes the whole article. Harmless at five a day; worth knowing before anyone reasons about D1 write quotas.

---

## 3. What's missing for daily use

- **The share target doesn't work.** `src/App.jsx:26` reads `?url`, immediately discards it with `history.replaceState`, and opens an **empty** `AddSheet`. The manifest also declares `text` and `title` params that nothing reads at all — and Android commonly puts the URL in `text`. On a phone, "share → NeatInfo" means "open the app and paste it again yourself." This is the primary mobile ingestion path in the PRD (§3.5, "Mobile") and it is two lines from working.
- **No offline reading.** `sw.js` deliberately never caches `/api/*`. That's defensible for the feed, but it means the PWA cannot show you a single article's text on a plane or a subway — the exact commute scenario TTS exists for. Caching `GET /api/articles/:id` for opened articles is the obvious missing piece.
- **No delete, no undo.** Keep/Dismiss are irreversible from the UI, and nothing can be removed.
- **No way to fix a bad title or summary from the UI**, though `PATCH` supports both (V1-30 added explicit `summary` write). You can only repair via `scripts/repair-entities.mjs` or curl.
- **No tags** (see above).
- **Nothing brings you back to the app.** No digest, no notification, no email, no unread badge outside the app. `docs/PROGRESS.md` names this as *the* risk to V1 — "Today is empty every day and you drift away" — and then explicitly declines to address it. The measured usage (1 keep) suggests the risk landed.
- **No highlights or excerpts.** One freeform `notes` field per article is thin for the "searchable forever" ambition; what you'd actually search for in three years is the sentence that mattered, not the whole piece.

---

## 4. Is it solving the right problem?

**The state model, yes — emphatically.** §2.1's diagnosis (the infinite queue becomes a guilt pile) is correct, and the lapse rule is the right structural fix rather than a discipline fix. That idea is worth the project on its own, and the code implements it faithfully.

**The archive premise, I think not.** §3 asserts "losing it deletes the project's entire value" and the code follows that conviction into R2 raw capture, a 2 MB/article budget, an export/import round trip, and a `raw_html_keys` manifest. But the content is **AI news commentary**, which is the most perishable category there is. A TechCrunch piece from eight months ago has near-zero retrieval value; a *paper* does, and a *note you wrote* does. The durable assets here are the starred subset and your own annotations — which are the two things receiving the least investment. I'd invert the storage conviction: keep raw HTML for arXiv and lab-blog primary sources, keep notes and stars forever, and let ordinary news lapse into metadata-only after a year.

**The response to the real risk was wrong.** The docs identify §9.1 correctly — the app dies of an empty Today, not of a bug. The response was to build discovery and a scoring ladder. But discovery doesn't solve an empty Today (auto items go to Pending by design, §7.7 — correctly), and it definitionally can't, because the constraint is that the owner opens the app, not that candidates exist. With 56 articles and one keep, the honest read is that the manual-ingest bet already failed, and `docs/PROGRESS.md` even proposed the measurement ("under 7 of 14 days" → automation moves up the queue) — then nobody ran it. That measurement is worth more than the entire `pipeline/` directory.

**V2's learning ladder is a fine personal-education goal but should be named as one.** §8 is transparently a curriculum, not a product requirement. That's legitimate — it's your project — but it's currently entangled with the app's schema, CI, and endpoint surface, which means the product carries maintenance for the curriculum. Keep the ladder; move it to a separate repo that reads through `/api/export`. `CLAUDE.md` already argues the boundary ("they never import each other"); take it one step further and make it a repository boundary.

---

## 5. Code quality and maintainability

**High, with one specific hazard.** Naming is good, functions are small, side effects are localised, `worker/importer.js` being pure so one code path serves both the test and the CLI is genuinely clever in a way that pays off. Nothing is obscure. Three months from now you'll be able to read this.

The hazard is **the comments have become a second, unversioned source of truth, and they're already wrong in places.** `worker/speech.js` contains the line "Comments elsewhere describing Tier 2 as 'R2 audio' predate that and are wrong" — a comment whose job is to correct other comments. Meanwhile `README.md`'s "Known gaps" section still says *"TTS is Tier 1 only… server-side audio in R2 drops in without touching the UI,"* which is false twice over (Tier 2 shipped; it explicitly stores nothing). Same section claims *"No curation, no scoring"* while `discover/`, `pipeline/`, and a Discover surface all exist. The API table omits `/api/candidates/*`, `/api/pipeline/*` and both audio routes, and lists `PATCH` as accepting `{notes, title, source, body_text, tags}` when the code also takes `author`, `summary` and `keep_fetch_status`. `docs/PROGRESS.md`'s own header says "231 tests across 13 files"; it's 397 across 20.

None of these are catastrophic individually. Collectively they mean the documentation is *load-bearing but not trustworthy*, which is the worst state for it to be in — it's long enough that you'll rely on it rather than reading the code, and wrong often enough that you shouldn't. The essays inside the code have the same problem at higher density, and they're the ones nobody re-reads when the code changes.

Two smaller things: `worker/index.js` at 1,262 lines is at the edge of comfortable — feed/ingest/transitions/audio/candidates/pipeline in one file. And the `LIST_COLUMNS` string interpolated into eight query templates is fine but will bite the first time someone adds a column and forgets `worker/importer.js`'s hardcoded `ARTICLE_COLUMNS` (the progress doc flags this risk itself and the round-trip test only catches it if the seeded row sets a non-default value).

---

## 6. What I'd do next, in order

**This week**

1. **Revoke the Cloudflare token in `secrets.md`**, issue a scoped replacement (Workers Scripts:Edit + D1:Edit only), put it in repo secrets, empty the file. This unblocks #2 as well.
2. **Fix the repo secrets so the CI deploy actually runs**, and stop deploying from the laptop. Right now the test gate protects nothing.
3. **Fix the share target** — four lines: read `url` *and* `text` from the query string, pass the value into `AddSheet` as an initial `url`, then `replaceState`. This is the highest value-per-line change in the repo.
4. **Fix `pipeline.yml`'s `working-directory`** (drop the `app` prefix in both places) or delete the workflow. A canary that has never fired is worse than no canary.
5. **Cap `batchResolveCandidates` at ~5 candidates per request** and have the client chunk, or make it enqueue and let keeps happen one at a time. Report per-candidate outcomes instead of failing the batch.

**This month**

6. **Add a scheduled export.** A GitHub Actions job on a weekly cron that hits `/api/export` and commits the JSON to a private repo or uploads it to R2 under a different prefix. Then fix the OOM path: stream the export as NDJSON per table rather than one `JSON.stringify`. Two hours, and it makes the project's stated core value actually durable.
7. **Fix candidate starvation** — make `getCandidates` return all pending candidates ordered by score, not just the newest batch, and drop `batch_id` from the reading path. Add a retention rule that skips candidates older than N days automatically, mirroring lapse.
8. **Rate-limit `POST /api/session`.** A `setting` row counting failures per hour and a 429 above ~20 is twenty lines and closes the only realistic route to the archive.
9. **Ship tags or delete them.** A tag input in the Reader is an hour. Otherwise remove the rail, the facet, the filter clause and `withTags` — they're dead weight and they make the archive UI promise something it can't do.
10. **Delete one of the two discovery implementations**, and make `discover/url.js` import from `worker/url.js` (one shared file, or a build step that copies it and a test that asserts they're identical).

**Then, and only then**

11. **Run the measurement `docs/PROGRESS.md` asked for.** Two weeks: how many days did you add anything, and how many articles did you actually resolve? If it's under half, no amount of Stage 1–5 scoring will help, and the next feature is a daily digest email that lands in your inbox with three links — not a classifier.
12. **Move `pipeline/` to its own repository** reading through `/api/export`. Keep the `article_feature` table (it's cheap and the versioning design is right); take the second language, the third workflow and the pytest suite out of the app's maintenance surface.
13. **Transcode Tier 2 audio, or say what it costs.** At minimum put the megabyte figure next to the play button so the choice is informed.
14. **Prune the documentation to what you'd actually re-read.** Keep `docs/PROGRESS.md` (it's the genuinely valuable artefact — the decision register with reasoning and reversals is excellent) and one root README that's *true*. Delete the eight per-directory READMEs and the seven `DIAGRAMS.md` files, or accept that they'll be wrong within two commits. The in-code essays could lose half their length without losing any of their content.

---

**One sentence of summary:** the thinking is better than the project needs and the follow-through is worse than the thinking deserves — the ideas that matter are built and correct, but the boring five-line fixes that decide whether anyone uses it have been passed over in favour of a second language and a scoring pipeline for a corpus of fifty-six articles.
