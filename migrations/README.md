# migrations/

One-off SQL for databases that already exist. Run by hand, once per database.

```bash
npx wrangler d1 execute neatinfo --local  --file=./migrations/0001-article-origin.sql
npx wrangler d1 execute neatinfo --remote --file=./migrations/0001-article-origin.sql
```

## Why these are not in `schema.sql`

`schema.sql` describes a database created from scratch, and the deploy workflow
**re-runs it on every push** — so everything in it must be idempotent, which
`CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` are.

SQLite has no `ADD COLUMN IF NOT EXISTS`. An unguarded `ALTER` in `schema.sql`
would therefore succeed once and fail every deploy afterwards. Those live here
instead.

A migration that *is* idempotent (`CREATE TABLE IF NOT EXISTS`) can be in both:
`0002` is, which is why the deploy applies it automatically and you only need
to run it by hand on a local database.

## Apply before the deploy that needs it

Not after. The new code selects the new column from the moment it ships, while
the currently-deployed code is unaffected by a column it does not know about.
Running the migration first is safe in both directions; running it second means
a window where production is broken.

## Running one twice

`0001` errors with "duplicate column name", which is the correct and harmless
outcome — it means the database already has it. `0002` is idempotent and simply
does nothing.

| File | What it adds | Idempotent |
|---|---|---|
| `0001-article-origin.sql` | `article.origin` — manual vs auto, so a poll fills Pending and never Today | No |
| `0002-article-feature.sql` | `article_feature` — §8 Stage 1 scores, keyed by `(article_id, version)` | Yes |
