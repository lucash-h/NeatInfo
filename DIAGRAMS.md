# NeatInfo — how the whole thing fits together

Two views: where articles come from and where they go, and what happens on an
ordinary day. Component-level diagrams live beside each component's README.

## The flow

Everything an article does, from being found to being archived.

```mermaid
flowchart TD
    subgraph finding["Finding things"]
        RSS["RSS feeds<br/>tiered by source"]
        HN["Hacker News<br/>Algolia index"]
        PASTE["You, pasting a URL"]
    end

    DISC["discover/<br/>dedup, relevance score"]
    CAND[("candidate<br/>status: pending")]
    DISCOVER_UI["Discover surface<br/>keep or skip"]

    RSS --> DISC
    HN --> DISC
    DISC --> CAND
    CAND --> DISCOVER_UI

    WORKER["POST /api/articles"]
    PASTE --> WORKER
    DISCOVER_UI -->|"kept: origin=auto"| WORKER

    EXTRACT["extract.js<br/>HTMLRewriter, entity decode"]
    WORKER --> EXTRACT
    EXTRACT -->|"raw HTML"| R2[("R2<br/>raw capture")]
    EXTRACT -->|"text, metadata"| D1[("D1<br/>article")]
    EXTRACT -.->|"fetch failed"| D1

    TODAY["Today<br/>added today, by you"]
    PENDING["Pending<br/>everything else undecided"]
    D1 -->|"origin=manual"| TODAY
    D1 -->|"origin=auto, or older"| PENDING

    ARCHIVE["Archive<br/>kept, dismissed, lapsed"]
    TODAY -->|"keep / dismiss"| ARCHIVE
    PENDING -->|"keep / dismiss"| ARCHIVE
    PENDING -->|"untouched 14 days"| ARCHIVE

    PIPE["pipeline/<br/>Stage 1 features"]
    D1 --> PIPE
    R2 --> PIPE
    PIPE --> FEAT[("article_feature<br/>score + explain")]
    FEAT -.->|"nothing reads this yet"| ARCHIVE
```

The dashed line to the archive is deliberate. §8's first rule is that **the
score sorts, it never filters** — features are computed and stored, and nothing
in the app acts on them until Stage 5 has established they are worth acting on.

## An ordinary day

Who calls whom, and when.

```mermaid
sequenceDiagram
    autonumber
    participant GA as GitHub Actions
    participant D as discover/
    participant W as Worker
    participant DB as D1 + R2
    participant You
    participant P as pipeline/
    participant AI as Workers AI

    Note over GA,D: every 6 hours
    GA->>D: node discover/index.js
    D->>D: fetch RSS + HN, dedup, score
    D->>W: POST /api/candidates (x-discover-key)
    W->>DB: insert candidates

    Note over You,W: whenever you open it
    You->>W: GET /api/feed?dayStart=...
    W->>DB: derive Today / Pending / Archive
    W->>DB: applyLapses() writes any that aged out
    W-->>You: three surfaces in one read

    You->>W: POST /api/articles/:id/resolve
    W->>DB: status + event row

    Note over You,AI: listening
    You->>W: GET /api/articles/:id/audio
    W-->>You: segment count
    You->>W: GET /api/articles/:id/audio/0
    W->>AI: melotts, ~45s of speech
    AI-->>W: base64 WAV
    W-->>You: audio/wav, stored nowhere

    Note over GA,P: nightly
    GA->>P: python pipeline/client.py
    P->>W: GET /api/pipeline/work?version=...
    W-->>P: articles lacking features at this version
    P->>W: GET /api/articles/:id/raw
    P->>P: count signals, score, explain
    P->>W: POST /api/pipeline/features
    W->>DB: upsert + canary timestamp
```

Two things the sequence makes obvious that prose does not:

**The Worker never schedules anything.** Lapsing happens inside a feed read;
discovery and the feature pass are driven from outside. There is no cron in the
Worker at all, which is why there is no overnight job to fail silently.

**Audio is never stored.** The Worker generates a segment and forgets it. At
88 KB per second of speech, caching a long article would be 252 MB — and §9.7
says not to hoard what is expensive and reproducible.
