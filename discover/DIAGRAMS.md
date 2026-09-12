# discover/ — diagrams

## The funnel

Many candidates in, a reviewable few out.

```mermaid
flowchart TD
    subgraph sources["Sources, by tier"]
        T1["Tier 1 — labs<br/>OpenAI, Anthropic, DeepMind, Meta"]
        T2["Tier 2 — press<br/>Verge, MIT TR, Ars"]
        T3["Tier 3 — crowd<br/>Hacker News"]
    end

    T1 --> PARSE["rss.js — regex parse"]
    T2 --> PARSE
    T3 --> HN["hn.js — Algolia index"]

    PARSE --> NORM["url.js — normalizeUrl<br/>strip utm_*, arXiv /pdf/ to /abs/"]
    HN --> NORM

    NORM --> D1{"same normalized URL?"}
    D1 -->|yes| KEEPHI["keep the higher-tier copy"]
    D1 -->|no| D2{"title trigram<br/>Jaccard > 0.45 ?"}
    D2 -->|yes| KEEPHI
    D2 -->|no| SCORE

    KEEPHI --> SCORE["score.js"]
    SCORE --> S1["keywords, title weighted 3x"]
    SCORE --> S2["tier bonus"]
    SCORE --> S3["recency: under 6h, 12h, 24h, 48h"]
    SCORE --> S4["HN points, capped at +10"]

    S1 --> TOP["sort, take top 30"]
    S2 --> TOP
    S3 --> TOP
    S4 --> TOP

    TOP --> POST["POST /api/candidates"]
    POST --> REVIEW["Discover surface<br/>you keep or skip"]
```

**Deduplication is the step that earns its place.** Without it, one big story
arrives as five items from five outlets and the day's batch is a single piece
of news wearing five hats. Exact URL catches syndication; title similarity
catches the same story written five ways.

This scores **relevance** — is it worth looking at — not quality. That is
`pipeline/`, which runs later on the full text.

## A run

```mermaid
sequenceDiagram
    autonumber
    participant GA as GitHub Actions
    participant I as index.js
    participant Feeds as RSS hosts
    participant Algolia
    participant W as Worker

    Note over GA: cron, every 6 hours
    GA->>I: node discover/index.js
    Note right of I: needs NEATINFO_API_URL<br/>and NEATINFO_DISCOVER_KEY,<br/>or it exits immediately

    loop each configured feed
        I->>Feeds: GET the feed
        Feeds-->>I: XML
        I->>I: parse, normalize, tag with tier
    end

    I->>Algolia: search HN
    Algolia-->>I: stories with points

    I->>I: deduplicate()
    I->>I: score() and sort
    I->>W: POST /api/candidates (x-discover-key)
    W-->>I: accepted count

    Note over I,W: a source that yields zero<br/>looks exactly like a quiet day --<br/>§9.6's silent parser failure
```

That last note is the failure mode to design against. A feed changing shape
produces no error, just fewer candidates, and it stays invisible until someone
notices the board is thin. If a source stops contributing, suspect the parser
before suspecting the world.
