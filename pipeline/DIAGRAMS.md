# pipeline/ — diagrams

## Where Stage 1 sits

The ladder from §8, and why only one rung is currently reachable.

```mermaid
flowchart TD
    S1["Stage 1 — heuristic features<br/>counting, no AI, no labels"]
    S2["Stage 2 — keep-rate per source<br/>the baseline everything must beat"]
    S3["Stage 3 — chunk + embed<br/>similarity, semantic search"]
    S4["Stage 4 — trained classifier"]
    S5["Stage 5 — blind evaluation"]

    S1 -->|"BUILT"| S2
    S2 --> S4
    S3 --> S4
    S4 --> S5

    LABELS{"labels available?<br/>1 keep, 0 dismissals"}
    S2 -.->|blocked| LABELS
    S4 -.->|blocked| LABELS
    S5 -.->|blocked| LABELS

    S1 -.->|"produces the features<br/>Stage 4 will train on"| S4
    S3 -.->|"needs no labels either --<br/>buildable next"| S3done["available now"]
```

The report ordered these 1→2→3→4→5 and that ordering is wrong for this project
today: Stages 2, 4 and 5 all learn from keep/dismiss decisions, and there is
one keep. Stage 1 and Stage 3 need no labels at all.

## What one feature pass does

```mermaid
flowchart LR
    TEXT["body_text"] --> COUNT["count"]
    HTML["raw HTML from R2"] --> LINKS["links + structure"]

    COUNT --> C1["numbers, dates per 100w"]
    COUNT --> C2["entity proxy per 100w"]
    COUNT --> C3["hype per 1000w"]
    COUNT --> C4["hedge per 1000w"]
    COUNT --> C5["methodology markers"]

    LINKS --> L1["primary-source ratio<br/>arxiv, doi, .gov, .edu"]
    LINKS --> L2["news-host links"]
    LINKS --> L3["tables, figures, headings"]

    C1 --> SCORE["score 0-100"]
    C2 --> SCORE
    C3 --> SCORE
    C4 --> SCORE
    C5 --> SCORE
    L1 --> SCORE
    L2 --> SCORE
    L3 --> SCORE

    SCORE --> EXPLAIN["explain: the three<br/>strongest contributors"]
    SCORE --> ROW[("article_feature<br/>(article_id, version)")]
    EXPLAIN --> ROW

    NOHTML["no raw capture<br/>~1 in 6 articles"] -.->|"rebalance, do not penalise"| SCORE
```

An article whose page returned 403 has no capture. Scoring it as "zero primary
sources" would rank it down for a failure of our plumbing rather than of its
writing, so the score is rebalanced onto what is known and the row records that
it was.

## The nightly run

```mermaid
sequenceDiagram
    autonumber
    participant GA as GitHub Actions
    participant C as client.py
    participant F as features.py
    participant W as Worker
    participant DB as D1

    Note over GA: cron, 06:00 UTC
    GA->>C: python pipeline/client.py
    Note right of C: sends a real User-Agent --<br/>urllib's default is blocked by<br/>Cloudflare with error 1010

    loop until nothing outstanding
        C->>W: GET /api/pipeline/work?version=VERSION
        W->>DB: articles with text and no features at VERSION
        W-->>C: up to 25, plus the remaining count

        loop each article
            opt has raw_html_key
                C->>W: GET /api/articles/:id/raw
                W-->>C: the captured HTML, or 404
            end
            C->>F: extract()
            F-->>C: score, explain, payload
        end

        C->>W: POST /api/pipeline/features
        W->>DB: upsert on (article_id, version)
        W->>DB: canary — last run, count, version
    end

    Note over C,W: interrupted halfway is ordinary:<br/>the work query only returns rows<br/>that still lack features
```

**Idempotence is structural, not defensive.** The Worker hands out only
articles missing features at this version, so a killed runner leaves the rest
outstanding and a re-run is a no-op. Bumping `VERSION` re-scores the corpus
into new rows without anything having to track staleness — and without
overwriting scores produced by different arithmetic, which Stage 5 will need to
compare.
