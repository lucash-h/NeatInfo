# NeatInfo — extraction, playback and the V2 pipeline

*2026-09-11. Written against the archive as it stands after the V1 hardening
round: 55 items in Pending, 45 with full text, tagged by provenance.*

Three threads, deliberately kept in one document because they share a
constraint (the Cloudflare free tier) and a sequencing argument (labels before
scorers):

1. **Two live defects** in extraction and playback, both diagnosed against
   production data rather than suspected.
2. **Better speech** — §6's Tier 2, which turns out to be affordable.
3. **A real pipeline** — metadata, chunking, embeddings: §8's ladder, costed.

Four decisions (D7–D10) were taken against this document on 2026-09-11 and are
recorded in §6; the sections above them reference those outcomes rather than
restating the choice.

The headline: the two defects are small and worth fixing this week; Tier 2
speech is free at this volume and fixes a problem Tier 1 structurally cannot;
and the V2 pipeline is *not* gated on money or infrastructure — it is gated on
having two weeks of your own triage decisions to learn from.

---

## 1. Extraction: HTML entities reach the UI undecoded

### The evidence

Querying production directly, of 55 rows: **5 titles and 6 summaries carry raw
HTML entities** — and, on closer inspection, **26 of the 45 bodies do too.**

> **Correction (2026-09-11, during implementation).** The first version of this
> section said body text was unaffected. That was an inference from the fields
> I had checked, not a measurement, and a test written against it failed
> immediately. HTMLRewriter does not decode entities in text nodes either — it
> preserves source bytes, which is correct behaviour for a streaming rewriter
> and not what I assumed. The defect is therefore about three times larger than
> first reported, and affects the majority of articles rather than a handful of
> headlines.

```
Ed Zitron&#39;s AI prediction track record
Muse: Meta&#039;s personal AI agent, features &amp; capabilities
Three sites made 215,128 &quot;best software&quot; pages for AI
Debian votes to allow &quot;responsible use of generative AI&quot;
```

### The cause

`worker/extract.js` takes title, summary, source and author from `<meta>`
**attributes**:

```js
const content = el.getAttribute('content');
```

HTMLRewriter returns **both attribute values and text chunks exactly as
written**. Nothing in the extraction path decodes anything, so every field it
produces — title, summary, source, author *and* body — carries whatever the
page escaped.

Body text hides it better only because prose contains fewer quotes and
ampersands than a headline does, not because it is handled differently.

### The fix

A small decoder applied to attribute-derived values only: the five named
entities that actually appear (`&amp; &lt; &gt; &quot; &#39;`) plus numeric
forms (`&#NN;`, `&#xNN;`). Not a general entity table — the long tail is not
worth carrying, and anything missed degrades to today's behaviour rather than
breaking.

Five places need it, not two: `Meta.element()` and `ArxivMeta.element()` for
attributes, and `Title.text()`, `Body`'s `onEndTag`, and `Collect.value` for
text.

**Decode where a unit is complete, never per chunk.** A text chunk boundary can
fall inside an entity (`&am` + `p;`), so decoding inside a `text()` handler
would silently miss those. `onEndTag` is the first point at which a block is
whole. The body's 40-character floor is applied *after* decoding, so it
measures real characters.

**Order matters:** decode must happen *before* `summarizeText()` and before the
`body_text` cap, or a truncation can land mid-entity and produce something
worse than what we started with.

### Repairing what is already stored

New extraction fixes new articles; the affected rows — 11 title/summary fields
and 26 bodies — need a pass of their own. `PATCH /api/articles/:id` already accepts `title`, so a script can decode
and re-write in place — the same shape as the title repair already run during
seeding. Roughly 20 lines, no schema change, no new endpoint.

**`summary` needs a route in.** It is not currently writable through `PATCH`
except when it is empty, so without a change the repair fixes five titles and
leaves six summaries ugly. Settled in **D8**: `PATCH` accepts an explicit
`summary`, added as a new field rather than by removing the existing guard.

---

## 2. Playback: Chrome stops after ~15 seconds, and chunking does not fix it

### The symptom

An article plays for a couple of paragraphs and then goes silent, with no error.

### The cause

`src/tts.js` splits text at 220 characters specifically to dodge this, and the
comment says so:

```js
// Chrome stops speaking after roughly fifteen seconds of a single utterance,
// so a long article is spoken as a queue of short ones.
export const CHUNK_CHARS = 220;
```

**That premise is wrong, and it is why the bug survived the mitigation.** Per
the Chromium reports, the limit is on *total time spent speaking*, not on the
length of any one utterance. A queue of twenty short utterances hits the same
wall as one long one.

The failure is then silent by construction: the engine stops, `end` never
fires, and `speakNext()` is waiting on `end` to advance the queue. No error
path is taken, so nothing is reported — the player simply sits in `playing`
forever.

### The fix

The documented workaround is a heartbeat — call `speechSynthesis.resume()`
every ~14 seconds while speaking. It is inelegant and it is what every
implementation does.

It belongs inside `webSpeechEngine`, not in the player: the player is the
engine-agnostic half, and Tier 2 must not inherit a workaround for a Web Speech
quirk. The interval has to be cleared on `cancel()`, on `end`, and on error, or
a stopped article leaves a timer poking a dead synth.

**Worth adding at the same time:** a watchdog. If no `boundary` or `end` event
arrives for a chunk within some multiple of its expected duration, treat it as
failed and surface it. The lesson of this bug is not the 15 seconds — it is
that the player had no way to notice it had stopped.

---

## 3. Tier 2 speech: affordable, and the only route to iOS lock-screen audio

§6 deferred server-side audio until it was confirmed you actually listen. You
do, so here are the numbers.

Workers AI gives **10,000 neurons/day free, on the free plan** (both free and
paid plans include the same daily allowance; the free plan simply stops there
rather than billing).

| Model | Price | At your volume |
|---|---|---|
| **MeloTTS** | 18.63 neurons / audio-minute | ~537 minutes/day free — about **9 hours of speech**. A 1,500-word article ≈ 10 min ≈ **186 neurons**, so **~50 articles/day** |
| Aura-2 (Deepgram) | 2,727 neurons / 1k chars | A single 10k-character article = **27,000 neurons** — 2.7× the entire daily allowance. **Not viable free.** |

So: MeloTTS, with enormous headroom against a five-article day.

### What it changes beyond voice quality

- **iOS screen-lock playback.** Tier 1 cannot survive a locked screen; a real
  `<audio>` element plus the Media Session API can. This is the actual reason
  to do it — the voice improvement is secondary.
- **The Chrome bug stops mattering.** Server-rendered audio has no 15-second
  limit, no `end`-event queue to stall.
- **Deterministic.** The same article sounds the same on every device, instead
  of depending on which voices the browser happens to have.

### Shape

`setEngine()` already exists as the swap point, and the player's interface is
`speak / pause / resume / stop` plus `available`. So:

1. Generate audio for `body_text` via MeloTTS.
2. Store the result in R2, keyed by article id (`audio/<id>.mp3`).
3. Serve it from a new route beside the existing `/api/articles/:id/raw`.
4. A second engine object plays that through `<audio>`, registering Media
   Session metadata.

No component changes. That was the point of building the seam.

### The three real tradeoffs

- **Latency.** Audio must exist before playback. Settled in **D7**: generate on
  first play and cache in R2 forever, so nothing is spent on the roughly
  four-in-five items dismissed unread and the wait happens once per article.
- **CPU.** Generation cannot happen inside a 10ms request. It needs
  `ctx.waitUntil()` with the client polling, or a queue.
- **Storage.** Audio is far bigger than HTML — roughly 1 MB per 10 minutes at
  modest bitrate. Settled in **D9**: its own counter, its own ceiling, and a
  combined budget that fits inside the free tier. Note that the raw-HTML budget
  is presently 8 GB of a 10 GB tier, which leaves no room for audio at all, so
  that constant comes down before the first byte of audio is written.

---

## 4. The pipeline: metadata, chunking, embeddings

### The binding constraint is not cost

| Piece | Cost | Verdict |
|---|---|---|
| BGE-M3 embeddings | 1,075 neurons / M input tokens | An article ≈ 2k tokens ≈ **2 neurons**. The whole current archive ≈ **112 neurons** |
| BGE-base-en-v1.5 | 6,058 neurons / M tokens | ≈ 12 neurons/article — still trivial |
| Vectorize | Free plan: 100 indexes, 20M vectors/index, up to 1536 dims | Sufficient by orders of magnitude |

Embedding the entire archive costs a rounding error against a daily allowance
you cannot otherwise spend. **The constraint is the 10ms CPU ceiling** — the
same lesson `defer` already encodes. Chunking and embedding must happen out of
the request path, in batches, not while someone waits for a page.

### What already exists

More than it looks:

- **Raw HTML in R2** — the substrate. §5.3's "capture greedily" bet is already
  paid for.
- **`GET /api/articles/:id/raw`** — the way to read it back.
- **`scripts/validate-capture.mjs`** — §5.4's check that what was captured is
  actually chunkable. Worth running *before* building on the assumption.
- **The event stream** — `added / opened / kept / dismissed / lapsed / starred`,
  written since day one precisely because v2 cannot reconstruct it.
- **Provenance tags** — new, and they make §8 Stage 2 a query rather than a
  project.

### §8's ladder, and why the order is the point

**Stage 1 — heuristic scoring.** Pure counting over text already stored:
specificity density (numbers, dates, entities per 100 words), primary-source
link ratio, hype markers against concrete claims, original vs. aggregation.
No AI, no dependencies, fully debuggable, runs free. It also produces the
feature vector a later classifier would train on, so it is not throwaway.

**Stage 2 — the dumb baseline.** Keep-rate per source: `kept / total` grouped by
publication. **This is now nearly free to build** — provenance tags mean
`hackernews` vs `tldr-ai` vs `hf-daily-papers` keep-rates are one query. §8 is
emphatic that this simple statistic is embarrassingly hard to beat, and that
building it *second* is what stops you believing a fancier model works when it
does not.

**Stage 3 — chunking and embeddings.** Chunk `body_text`, embed via Workers AI,
store in Vectorize, score new items by similarity to the centroid of the
starred set. Semantic search over the archive falls out free.

Design notes for when it happens:
- Chunk on paragraph boundaries with overlap, not fixed character counts —
  `body_text` already preserves `\n\n` from extraction.
- Store chunk → article id in Vectorize metadata so a hit resolves to a row.
- Embed `summary` separately from body chunks; a summary hit means something
  different from a body hit.
- Re-embedding must be idempotent and resumable; a partial run is normal.

**Stage 4 — a trained classifier**, and **Stage 5 — blind evaluation**, both
unchanged from §8. Stage 5 is the one most likely to be skipped and the one
that makes the rest honest.

### The gate is labels, not capability

Stages 2–4 all learn from your keep/dismiss decisions. **You currently have
three.** Everything above can be built in advance and would be learning from
noise. That is the real sequencing argument, and it is the same one §9.1 makes
about the empty page: the bottleneck is usage, not engineering.

---

## 5. Recommended order

1. **The two defects** (§1, §2). Small, self-contained, and both degrade the
   thing you are using today. Include the repair pass for the 11 stored rows.
2. **MeloTTS Tier 2** (§3). The seam exists, the budget is not a constraint,
   and it is the only path to lock-screen listening.
3. **Stage 1 heuristics** (§4). Free, no infrastructure, no labels required,
   and it builds the features later stages need.
4. **Two weeks of triage.** Not a task — a precondition.
5. **Stages 2 and 3**, once there are labels worth learning from.

### Two rules to hold regardless

Carried forward from §8 because they are the ones most easily lost:

- **The score sorts, it never filters.** A system that hides things builds a
  filter bubble you cannot detect, because the evidence it is wrong is exactly
  what it withheld.
- **The score must be explainable in one line.** An unexplained number gets
  ignored within a week, because when it is wrong you cannot tell whether it is
  wrong *this time* or wrong *generally*.

---

## 6. Decisions taken

All four were settled on 2026-09-11.

### D7 — Audio is generated on first play. **Decided: first play.**

Nothing is spent on the roughly four-in-five items that get dismissed unread,
at the cost of a wait the first time an article is played. Cached in R2 by
article id thereafter, so the wait happens once per article, ever. This is the
same "capture greedily, process lazily" rule (§5.3) the ingest path already
follows.

### D8 — `PATCH` may write `summary`. **Decided: yes.**

Without it the entity repair can fix titles and not summaries, which is half a
fix.

**Implement it as a new explicit field, not by removing the existing guard.**
The guard lives in the `body_text` branch of `updateArticle`: when text is
pasted, the summary is filled *only if empty*, so that completing an article
cannot silently rewrite a summary you have already read. That intent is still
right. Accepting an explicit `summary` in the PATCH body is a different
statement — the caller is saying precisely what it wants — and it leaves both
the paste path and `refetch` behaving exactly as they do now.

So: explicit `summary` wins; derived summary still defers to what is there.

### D9 — Audio gets its own budget line, separately enforced. **Decided: yes, hard caps.**

R2's free tier is **10 GB-month of standard storage, 1M Class A and 10M Class B
operations per month**. The documentation does not state what happens when an
account without a payment method exceeds it, so the safe assumption is that it
may bill rather than block. Enforcement therefore belongs in the code, not in
the platform.

What this requires:

- **Separate accounting per class.** `r2_usage_bytes` currently counts raw HTML
  and is the number `/api/settings` reports. Audio is roughly an order of
  magnitude larger per article; folding it into the same counter makes both
  figures meaningless. Two keys, two budgets, two figures in Settings.
- **A hard pre-flight check.** `captureRaw()` already refuses a write that would
  cross its ceiling and re-measures before refusing, so the pattern exists and
  should be reused rather than reinvented.
- **A combined ceiling below the free tier**, not merely two ceilings that each
  look reasonable. Raw is currently budgeted at 8 GB of a 10 GB tier, which
  leaves no room for audio at all — **that constant has to come down before any
  audio is written.** Suggested split: 6 GB raw, 2 GB audio, 2 GB headroom.
- **Workers AI is the safer half.** The free plan blocks at 10,000 neurons/day
  rather than billing, so the failure there is an interruption, not an invoice.
  It should still be counted, because a silent daily cap is exactly the kind of
  failure §7 warns about.

### D10 — Chunk by job, not by one global size. **Decided: document-level first, chunking when search is built.**

The proposal was 2048 or ~7096 with 10–20% overlap. Measured against the real
archive, the distribution argues against a single number:

| | words | ~tokens |
|---|---|---|
| median | 445 | 592 |
| p75 | 2,575 | 3,425 |
| p90 | 7,141 | 9,498 |
| max | 30,556 | 40,639 |

The archive is **bimodal**: arXiv abstracts and short news at 200–500 words,
long-form at 7k–30k. **Only 15 of 45 articles exceed 2048 tokens at all.**

So at 2048, two-thirds of the archive is a single chunk — that is
document-level embedding wearing a chunking label. At ~7096 it is forty of
forty-five, which is document-level embedding with extra steps.

That is not an argument that 2048 is wrong. It is an argument that **the two
jobs in §8 Stage 3 want different granularities**:

- **Scoring a new item against the centroid of the starred set** — a *document*
  question. One vector per article is correct, and it is what the short half of
  the archive gives you for free. For a 30k-word piece, embed the summary plus
  the opening rather than averaging twenty chunks into mush.
- **Semantic search over the archive** — a *passage* question. Here 2048 is too
  coarse: in a 30k-word article it produces ~20 chunks of roughly three pages
  each, so a query matching one paragraph returns a vector where that paragraph
  is about 5% of the content. Retrieval precision comes from chunks in the
  **300–500 token** range with **10–15% overlap**, split on paragraph
  boundaries — `body_text` already preserves `

` from extraction.

**Recommended order.** Build document-level embeddings first: it serves the
scoring use case that Stage 3 exists for, it is one vector per article, and it
is trivially cheap. Add a passage-level index only when semantic search is
actually being built, as a second namespace rather than a replacement.

**Cost does not constrain this choice.** The entire current archive is ~176,000
tokens — about **190 neurons** with BGE-M3, against 10,000 free per day. Either
granularity is affordable; retrieval quality is the only real input.

**One irreversible detail:** a Vectorize index has its dimension fixed at
creation (1536 max). BGE-M3 and BGE-base emit different widths, so the model is
chosen before the index exists, and changing it later means rebuilding.

## 7. Risks

**The 15-second bug is a class, not an instance.** The player could not tell
that it had stopped. Whatever is built next — audio generation, embedding runs,
a scheduled poll — should be assumed to fail silently unless it reports
otherwise. §9.6 already says this about newsletter parsers; it generalises.

**Tier 2 makes an external dependency load-bearing.** Today, speech works
offline with no account. After Tier 2, listening depends on Workers AI being
up and within budget. Keeping Tier 1 as a fallback is cheap and worth doing —
`setEngine()` makes it a runtime choice.

**Stage 1 heuristics can be built and then quietly trusted.** Without Stage 5's
blind evaluation they are just plausible-looking numbers. Build them; do not
start sorting by them until something has checked them.

---

## Sources

- Chromium: [Speech Synthesis stops abruptly after about 15 seconds (#41294170)](https://issues.chromium.org/issues/41294170)
- Chromium: [speechSynthesis fails for long text without warning (#41346274)](https://issues.chromium.org/issues/41346274)
- [Cross-browser speech synthesis — the hard way and the easy way](https://dev.to/jankapunkt/cross-browser-speech-synthesis-the-hard-way-and-the-easy-way-353)
- [Workers AI — models](https://developers.cloudflare.com/workers-ai/models/)
- [Workers AI — pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Vectorize — limits](https://developers.cloudflare.com/vectorize/platform/limits/)
- `NeatInfo_Design_Report.md` §5.3, §6, §8, §9.1, §9.6
