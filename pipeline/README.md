# pipeline/

*Diagrams: [`DIAGRAMS.md`](DIAGRAMS.md) — where Stage 1 sits, and the nightly run.*

Stage 1 of the V2 ladder (design report §8): features derived from an article's
own text and raw capture, by counting. No AI call, no embeddings, no labels.

Python, not JavaScript, because Stages 4 and 5 — training a classifier and
evaluating it blind — are Python whether we like it or not, and features
computed here are consumed there. The Worker and `discover/` stay JavaScript;
the two sides never import each other.

```bash
python -m pytest pipeline/ -q                        # the tests
python pipeline/client.py --base http://localhost:8787 --dry-run
NEATINFO_DISCOVER_KEY=... python pipeline/client.py --base https://...
```

Runs nightly from `.github/workflows/pipeline.yml`.

---

## Why this stage and not a better one

§8 ladders five stages, and the ordering in the report is 1→2→3→4→5. Measured
against the live archive, that ordering is wrong for this project right now:

```
events: added 56, opened 8, listened 2, kept 1
```

**One keep, zero dismissals.** Stage 2 is keep-rate per source, which is
undefined on that data; Stage 4 trains on it. Stage 1 needs no labels at all,
and it produces exactly the features Stage 4 will train on once there are some.
So it is the only rung currently reachable, and building it is not throwaway.

The bottleneck is triage, not compute. Worth restating because it keeps looking
like an infrastructure problem: the whole corpus is ~176k tokens, which an 8B
model reads for about 1,000 of the 10,000 neurons Cloudflare gives away daily.

## Why it does not run in a Worker

The feature pass loops over megabytes of text. The Workers free plan allows
**10ms of CPU per invocation**, and V1-32 learned what that means the expensive
way: a base64 decode loop measured ~14ms and would have failed every request in
production, while `wrangler dev` — which does not enforce CPU limits — showed
nothing. GitHub Actions has a full runtime and no such ceiling.

## The signals

Every one is a proxy. Each is written down with what it stands for and what
would disprove it, because a signal nobody can argue with is a signal nobody
can fix.

| Signal | Proxy for | Would be disproved by |
|---|---|---|
| Numbers and dates per 100 words | Concrete claims over gesturing | A dense listicle of specs that says nothing |
| Entity density | Naming actors rather than "experts say" | Press releases, which name everyone |
| Hype phrases per 1000 words | Churn | A genuinely remarkable result described plainly *by* a hype-prone outlet |
| Hedge phrases per 1000 words | Speculation about a thing, not a report of it | Careful scientific writing, which hedges honestly |
| Primary-source link ratio | Pointing at papers and filings, not at coverage | An analysis piece whose value *is* synthesising coverage |
| Structural markers | Methodology, limitations, ablations | A paper-shaped blog post |
| Structural tags | Tables, figures, headings | A well-formatted opinion piece |

The entity signal is a **regex stand-in for NER** — capitalised runs that are
not sentence-initial. Real NER wants spaCy, which is a few hundred megabytes
and a Docker image. That upgrade waits until Stage 5 says the feature earns it.

## The two rules, enforced rather than remembered

From §8, and both are load-bearing:

**The score sorts, it never filters.** Nothing in this module drops an article,
and nothing in the app reads the score yet. A system that hides things builds a
filter bubble you cannot detect, because the evidence it is wrong is exactly
what it withheld.

**The score must be explainable in one line.** `explain()` produces that line
and it is stored in its own column next to the number. An unexplained score
gets ignored within a week, because when it is wrong you cannot tell whether it
is wrong *this time* or wrong *generally*.

## Versioning, and why scores are never overwritten across versions

`VERSION` in `features.py` is bumped whenever a signal changes meaning. The
Worker keys features on `(article_id, version)`, so a bump re-scores the corpus
into new rows rather than replacing the old ones. Two scores produced by
different arithmetic are not comparable, and once they share a row that
difference is invisible — which is precisely what Stage 5 would need to see.

## What it is honest about

- **Roughly one article in six has no raw capture** (a 403, a paste, a page
  over the 2 MB cap). Those get text-only features, a note saying so, and a
  rebalanced score. Scoring them as "zero primary sources" would rank an
  article down for a failure of our plumbing rather than of its writing.
- **The scale compresses at the top.** Run over the real archive the median is
  ~74 and roughly a third sits above 85, because many technical articles max
  out both the specificity and primary-source terms. It discriminates well at
  the bottom and poorly at the top. Deliberately not tuned: with one label,
  tuning against 46 articles is fitting noise. Stage 5 settles it.
- **The weights are stated, not learned**, and almost certainly wrong in
  detail. That is what Stage 2's baseline and Stage 5's evaluation are for.

## The canary

The Worker records the last run, the count and the version, and Settings shows
them — "Features · 46 scored 9h ago", or a warning when it is more than two
days old. A nightly job that quietly stops is invisible for a week (§9.6), and
this project has already met that failure twice.
