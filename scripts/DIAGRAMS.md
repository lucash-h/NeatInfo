# scripts/ — diagrams

## What each one is for

Four tools, three jobs: fill the board, fix what is stored, get the data back.

```mermaid
flowchart TD
    subgraph fill["Filling the board"]
        GATHER["gather-candidates.mjs"]
        TLDR["TLDR AI<br/>borrowed human curation"]
        HN["Hacker News<br/>points as a filter"]
        HF["HF daily papers<br/>voted arXiv"]
        TLDR --> GATHER
        HN --> GATHER
        HF --> GATHER
        GATHER --> JSON[("candidates.json")]
        JSON --> SEED["seed-articles.mjs"]
        SEED -->|"POST /api/articles<br/>origin=auto"| APP["NeatInfo"]
    end

    subgraph fix["Fixing what is stored"]
        REPAIR["repair-entities.mjs"]
        APP --> REPAIR
        REPAIR -->|"decode locally, PATCH back"| APP
        REPAIR -.->|"--refetch: only rows a<br/>decode cannot reach"| APP
    end

    subgraph back["Getting it back"]
        APP -->|"GET /api/export"| PAYLOAD[("JSON payload")]
        PAYLOAD --> IMPORT["import.mjs"]
        IMPORT --> SQL[("restore.sql")]
        SQL --> D1[("wrangler d1 execute")]
        PAYLOAD --> VALIDATE["validate-capture.mjs<br/>is the raw capture<br/>actually chunkable?"]
    end
```

Seeding goes through `POST /api/articles` rather than inserting into D1, so
extraction, the arXiv slice, duplicate detection, the body cap and raw capture
all behave exactly as they do for a hand-pasted link. **A bulk load cannot
create rows the app could not have created itself.**

## Seeding, step by step

```mermaid
sequenceDiagram
    autonumber
    participant You
    participant G as gather-candidates.mjs
    participant Sources
    participant S as seed-articles.mjs
    participant W as Worker
    participant Site as The article's host

    You->>G: --out candidates.json
    G->>Sources: TLDR AI, HN Algolia, HF papers
    Sources-->>G: links, titles, points
    G->>G: drop sponsors by utm_source
    G->>G: drop social, dedupe by host+path
    G-->>You: candidates.json
    Note right of G: a source yielding zero prints<br/>a warning -- a quiet zero looks<br/>exactly like a slow news day

    You->>S: --file candidates.json
    S->>S: passphrase from app/.env
    S->>W: POST /api/session
    W-->>S: signed cookie

    loop each candidate, paced
        S->>W: POST /api/articles {url, origin: auto}
        W->>Site: fetch and extract
        alt 403 or paywall
            Site-->>W: refused
            W-->>S: 201 with fetchError
            S->>W: PATCH title from the feed
            Note right of S: an item you cannot identify<br/>is one you never go back to
        else fetched
            Site-->>W: page
            W-->>S: 201
        end
        S->>W: PATCH tags [source]
    end

    S-->>You: added / needs text / already present
```

`origin: 'auto'` is what puts fifty links in **Pending** rather than on Today.
Dumping them onto Today would destroy the one property that page has — being
short enough to finish.

Re-running over the same file is safe: the duplicate guard answers 409 and the
script counts it as *already present* rather than adding anything twice.
