# test/

```bash
npm test            # one pass
npm run test:watch
```

Vitest, running **inside workerd** via `@cloudflare/vitest-pool-workers` — so
`HTMLRewriter`, D1 and R2 behave the way they do in production rather than the
way a mock would.

(The Python tests for `pipeline/` are separate: `python -m pytest pipeline/ -q`.)

## The three things that surprise people

**Storage is shared across tests.** The pool runs a single worker and no longer
rolls storage back between tests, so every stateful file calls `resetDb()` in
`beforeEach`. A test that passes alone and fails in the suite is almost always
a missing reset.

**Tests read `wrangler.test.toml`, not `wrangler.toml`.** The two are identical
except that the Workers AI binding is removed. AI has no local mode: declaring
it makes the pool open a *remote* proxy session requiring
`CLOUDFLARE_API_TOKEN`, which would make `npm test` depend on Cloudflare
credentials — including in CI, where the test gate deliberately runs before the
steps that hold them. `wrangler.test.toml` is generated; `node
scripts/sync-test-config.mjs` regenerates it and fails if it has drifted, and
CI runs that check before the tests.

**`PRAGMA` is stripped from `schema.sql`** when the harness applies it, so
foreign keys are not enforced here. Never assert behaviour that depends on
them — that is a property of the environment, not of the code. Validate in the
worker instead, as `putPipelineFeatures` does.

## What good tests look like in this codebase

Written after several that looked fine and proved nothing:

- **Fakes must be able to fail.** A fake `<audio>` whose `play()` always
  resolves hid two real bugs; a fake clock that discarded its delay meant
  `HEARTBEAT_MS` could have been ten minutes and four tests still passed.
  Model the awkward parts: rejected promises, `NaN` duration, events after
  cancel.
- **Pin exactly-one, not at-least-one.** The entity test uses a
  double-escaped fixture so it fails if nothing decoded *and* if something
  decoded twice.
- **Assert ordering, not magnitudes**, where the numbers are arbitrary. The
  feature tests say a paper outranks a hype post; they do not say by how much,
  because nobody has justified a particular number.
- **Ask whether the test can fail.** Delete the line under test and run it. If
  it still passes, it was decoration.

## Layout

One file per concern — `auth`, `router`, `feed`, `ingest`, `archive`, `search`,
`extract`, `arxiv`, `url`, `r2`, `raw`, `export`, `origin`, `speech`,
`pipeline`, `tts`, `truncate`, `helpers`, `client-api`, `smoke`. `helpers.js`
is shared scaffolding, not a test file: `applySchema`, `resetDb`,
`seedArticle`, `call`/`callJson`, `sessionCookie`.

The schema comes from `schema.sql` itself rather than being restated here, so a
migration that is wrong in production is wrong in the tests too.
