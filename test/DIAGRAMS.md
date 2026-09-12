# test/ — diagrams

## How the harness is put together

```mermaid
flowchart TD
    NPM["npm test"] --> VITEST["vitest"]
    VITEST --> POOL["@cloudflare/vitest-pool-workers"]
    POOL --> CFG["wrangler.test.toml"]

    CFG -.->|"generated from"| REAL["wrangler.toml"]
    CFG -->|"minus the [ai] block"| WHY["AI has no local mode:<br/>declaring it opens a remote proxy<br/>needing CLOUDFLARE_API_TOKEN"]
    SYNC["scripts/sync-test-config.mjs<br/>CI fails if these drift"] -.- CFG

    POOL --> WORKERD["workerd<br/>real HTMLRewriter, D1, R2"]

    SCHEMA["schema.sql"] --> APPLY["applySchema()"]
    APPLY -->|"PRAGMA stripped"| NOFK["foreign keys NOT enforced here"]
    APPLY --> WORKERD

    WORKERD --> RESET["resetDb() in beforeEach"]
    RESET --> SHARED["one shared D1 file --<br/>the pool no longer rolls back"]

    PY["python -m pytest pipeline/"] --> PYTESTS["features.py tests<br/>separate, plain Python"]
```

The two surprises are on that diagram: **storage is shared**, so a test passing
alone and failing in the suite is almost always a missing `resetDb()`; and
**`PRAGMA` is stripped**, so foreign keys are not enforced — never assert
behaviour that depends on them, because that is a property of the environment
rather than of the code.

## One test's life

```mermaid
sequenceDiagram
    autonumber
    participant V as vitest
    participant H as helpers.js
    participant DB as D1 (workerd)
    participant T as the test
    participant W as worker.fetch

    V->>H: beforeAll -> applySchema()
    H->>DB: each statement from schema.sql
    Note right of H: triggers are split correctly --<br/>CREATE TRIGGER contains semicolons<br/>that are not statement boundaries

    V->>H: beforeEach -> resetDb()
    H->>DB: delete rows, reseed lapse window

    T->>H: seedArticle({...})
    H->>DB: INSERT ... RETURNING id
    T->>H: callJson('/api/...')
    H->>H: attach a signed session cookie
    H->>W: worker.fetch(request, env, ctx)
    W->>DB: read / write
    W-->>T: response
    T->>DB: assert the stored row, not just the response

    Note over T,DB: reading the column back is the point --<br/>a response can be right while the<br/>write was wrong
```

## The question to ask of any test here

```mermaid
flowchart LR
    Q["Delete the line under test.<br/>Does the test fail?"]
    Q -->|yes| GOOD["it is load-bearing"]
    Q -->|no| BAD["it is decoration"]

    BAD --> EX1["a fake audio whose play()<br/>always resolves"]
    BAD --> EX2["a fake clock that<br/>discards its delay"]
    BAD --> EX3["a fixture that passes whether<br/>or not anything decoded it"]
```

All three of those are real, from this codebase, and each hid a bug that
reached review. The fakes now reject, report `NaN` duration, record their
delays, and the entity fixture is double-escaped so it fails if nothing decoded
**and** if something decoded twice.
