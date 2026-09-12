# migrations/ — diagrams

## Where does a schema change go?

```mermaid
flowchart TD
    CHANGE["a schema change"] --> FRESH["add it to schema.sql<br/>-- always, for new databases"]
    FRESH --> IDEM{"is the statement<br/>idempotent?"}

    IDEM -->|"CREATE TABLE IF NOT EXISTS<br/>CREATE INDEX IF NOT EXISTS<br/>INSERT OR IGNORE"| DONE["done -- the deploy re-runs<br/>schema.sql on every push<br/>and it is safe"]

    IDEM -->|"ALTER TABLE ADD COLUMN"| WHY["SQLite has no<br/>ADD COLUMN IF NOT EXISTS"]
    WHY --> BREAK["in schema.sql it would succeed once<br/>and fail every deploy after"]
    BREAK --> MIG["put the ALTER in migrations/<br/>run by hand, once per database"]

    MIG --> ORDER["apply it BEFORE the deploy<br/>that needs it"]
    DONE --> ORDER
```

## Why the order is that way round

```mermaid
sequenceDiagram
    autonumber
    participant You
    participant D1 as remote D1
    participant CI as GitHub Actions
    participant Prod as the live Worker

    rect rgba(120,180,120,0.12)
    Note over You,Prod: correct order
    You->>D1: apply the migration
    Note right of D1: old code ignores a column<br/>it does not know about
    You->>CI: merge to main
    CI->>D1: schema.sql (idempotent)
    CI->>Prod: wrangler deploy
    Prod->>D1: SELECT ... the new column
    Note right of Prod: it is already there
    end

    rect rgba(200,120,120,0.12)
    Note over You,Prod: the other way round
    You->>CI: merge to main
    CI->>Prod: wrangler deploy
    Prod->>D1: SELECT ... the new column
    D1-->>Prod: no such column
    Note right of Prod: every feed read 500s<br/>until the migration lands
    end
```

Applying first is safe in both directions: the currently-deployed code is
unaffected by a column it never mentions. Applying second leaves a window where
production is broken, and the length of that window is however long it takes
you to notice.

| File | Adds | Idempotent | Run by hand |
|---|---|---|---|
| `0001-article-origin.sql` | `article.origin` | No — `ALTER` | Yes, local and remote |
| `0002-article-feature.sql` | `article_feature` | Yes | Local only; the deploy handles remote |
