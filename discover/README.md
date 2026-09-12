# discover/

Finds candidate articles and queues them for review. Runs every 6 hours from
`.github/workflows/discover.yml`.

```
poll RSS + Hacker News -> normalize -> deduplicate -> score -> POST top N
```

| File | What it does |
|---|---|
| `index.js` | The orchestrator, and the tiered feed list |
| `rss.js` | RSS/Atom parsing, by regex |
| `hn.js` | Hacker News, via the free Algolia index |
| `dedup.js` | Exact URL, then title-trigram Jaccard at 0.45 |
| `score.js` | Keyword relevance × position, source tier, recency, HN points |
| `url.js` | URL normalization — **mirrors `worker/url.js`** |

Candidates land in the `candidate` table with `status='pending'` and are
reviewed on the Discover surface. Promoting one creates an article with
`origin='auto'`, which puts it in Pending rather than Today.

## This is relevance, not quality

`score.js` answers *"is this worth looking at?"* — keywords, a hand-ranked
source tier, recency, crowd signal. It is §7.5's options 1 and 2, and it runs
before an article exists.

`pipeline/` answers a different question — *"is this any good?"* — from the
full text after ingest. The two are complementary and neither replaces the
other; they only look alike because both produce a number called a score.

## Two constraints to preserve

**No npm dependencies.** RSS parsing is regex-based on purpose: this runs every
6 hours and install time is in its hot path. That is a property of *this*
component, not a project rule — `pipeline/` is Python and has requirements.

**`url.js` mirrors `worker/url.js`.** Two runtimes need the same normalization
and neither can import the other, so changing a dedup rule means changing both.
This is a real duplication hazard and it is the reason `pipeline/` stores its
features rather than recomputing them on the other side.

## Deduplication is the underrated part

Without it, one big story arrives as five items from five outlets and a day's
batch is a single piece of news. Exact URL match catches syndication; trigram
similarity on titles catches the same story written five ways.

## Credentials

`NEATINFO_API_URL` and `NEATINFO_DISCOVER_KEY`, from repo secrets. The key is
the `x-discover-key` header the Worker checks — the same one `pipeline/` uses,
deliberately, so there is one machine credential to rotate rather than two.

## The failure mode to watch

A feed that changes shape yields zero items and says nothing. §9.6 is explicit
that this kind of parser fails *silently*, and a quiet zero looks exactly like
a slow news day. If a source stops contributing, suspect the parser before
suspecting the world.
