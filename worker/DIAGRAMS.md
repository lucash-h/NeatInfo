# worker/ — diagrams

## Request routing

Everything that arrives, and the two gates it can pass through.

```mermaid
flowchart TD
    REQ["fetch(request)"] --> API{"path starts<br/>with /api/ ?"}
    API -->|no| ASSETS["env.ASSETS<br/>the built SPA"]

    API -->|yes| SESSION{"/api/session ?"}
    SESSION -->|yes| AUTH["POST: check passphrase<br/>GET: am I signed in<br/>DELETE: clear cookie"]

    SESSION -->|no| PIPE{"/api/pipeline/* ?"}
    PIPE -->|yes| KEY{"x-discover-key<br/>matches?"}
    KEY -->|no| K401["401"]
    KEY -->|yes| PIPEROUTES["work · features"]

    PIPE -->|no| CAND{"/api/candidates<br/>POST ?"}
    CAND -->|yes| KEY2{"x-discover-key<br/>matches?"}
    KEY2 -->|no| K401
    KEY2 -->|yes| INGEST["ingest candidates"]

    CAND -->|no| COOKIE{"signed cookie<br/>valid?"}
    COOKIE -->|no| C401["401 — the Gate takes over"]
    COOKIE -->|yes| ROUTES["feed · facets · articles<br/>settings · export · audio · raw"]

    ROUTES --> CATCH{"threw?"}
    CATCH -->|yes| E500["500 with the message"]
    CATCH -->|no| OK["JSON"]
```

Two auth schemes on purpose: a **person** gets a session cookie, a **machine**
gets `x-discover-key`. A pipeline key cannot read your archive as you, and the
machine routes are checked before the cookie gate rather than after, so they
never depend on a session existing.

## Ingest, step by step

`POST /api/articles` — the most consequential procedure in the file.

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller
    participant W as addArticle
    participant U as url.js
    participant DB as D1
    participant X as extract.js
    participant Site as The article's host
    participant R2

    C->>W: {url} or {text}, optional origin / defer
    W->>U: normalizeUrl()
    Note right of U: strips utm_*, sorts params,<br/>points arxiv /pdf/ at /abs/
    W->>DB: SELECT by url_normalized
    alt already present
        DB-->>W: existing row
        W-->>C: 409 with the article
    end

    alt defer = true
        Note over W: insert the row now,<br/>fetch the page later
    else fetch now
        W->>X: extractArticle(normalized)
        X->>Site: GET
        alt 403 / 404 / non-HTML
            Site-->>X: refused
            X-->>W: ok:false + fetch_status
            Note over W: the row is still created --<br/>never a dead end
        else HTML
            Site-->>X: page
            X->>X: HTMLRewriter: meta, title, blocks
            X->>X: decodeEntities everywhere
            X-->>W: title, summary, body, html
            W->>R2: captureRaw() if within budget
        end
    end

    W->>W: truncateBodyText() — D1 rejects >1 MB
    W->>DB: INSERT ... RETURNING
    W->>DB: INSERT event 'added'
    W-->>C: 201 with the article
```

The branch that matters is the failed fetch: it still creates a row. A login
wall or a dead host leaves an article with a URL, a `fetch_status` and a paste
box — §3's rule that the app is never a dead end applies *after* ingest too.
