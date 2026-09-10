// Archive search and the SQL behind it. §3 "Store"
//
// FTS5's MATCH grammar treats `(`, `)`, `:`, `^`, `*`, `"`, `-`, `AND`, `OR`,
// `NOT` and `NEAR` as syntax, so any of them arriving from a search box is a
// query the engine either misreads or rejects outright with a syntax error --
// which surfaced as a 500 on ordinary punctuation (`gpt (4)`, `cost-benefit`).
// Rather than blocklisting the characters that hurt today, the whole input is
// re-tokenized: nothing from the user is ever handed to fts5 as syntax.

// Longer than any real search word; a bound so one absurd token cannot make an
// absurd query plan.
const MAX_TOKEN = 64;
const MAX_TOKENS = 16;

// Everything that is not a letter or a digit is a separator. `\p{L}`/`\p{N}`
// rather than `\w` so accented and non-Latin queries survive.
const SEPARATORS = /[^\p{L}\p{N}]+/u;

// Turns raw user input into a safe fts5 MATCH expression, or null when nothing
// searchable survives -- the caller then shows the unfiltered archive rather
// than an error or an empty page.
export function ftsQuery(raw) {
  const tokens = String(raw ?? '')
    .split(SEPARATORS)
    .filter(Boolean)
    .map((t) => t.slice(0, MAX_TOKEN))
    .slice(0, MAX_TOKENS);

  if (!tokens.length) return null;

  // Each token becomes a quoted string, so `AND`, `NEAR` and friends are
  // matched as words instead of operators. Only the last token gets the
  // prefix `*`, which is what makes search-as-you-type feel live.
  return tokens
    .map((t, i) => `"${t}"` + (i === tokens.length - 1 ? '*' : ''))
    .join(' ');
}

// One place that builds the archive query, so filters (§3 "Store": date range,
// source, tag, status, favorite) can be composed onto it later without
// re-deriving the search half. Conditions are anonymous `?` placeholders in a
// flat array, which is what makes appending a clause a one-liner.
export function buildArchiveQuery({
  columns,
  topicId,
  match = null,
  limit = 200,
  offset = 0,
  clauses = [],
  binds = []
}) {
  const where = [];
  const values = [];

  if (match) {
    where.push('article_fts MATCH ?');
    values.push(match);
  }

  where.push('a.topic_id = ?');
  values.push(topicId);
  where.push(`a.status != 'new'`);

  // Extra filters supplied by the caller, already written against the `a`
  // alias with their own `?` placeholders.
  for (const clause of clauses) where.push(clause);
  values.push(...binds);

  const cols = columns.split(',').map((c) => 'a.' + c.trim()).join(', ');
  const from = match
    ? `FROM article_fts f JOIN article a ON a.id = f.rowid`
    : `FROM article a`;
  const order = match ? 'ORDER BY rank' : 'ORDER BY COALESCE(a.resolved_at, a.added_at) DESC';

  const sql = `SELECT ${cols} ${from} WHERE ${where.join(' AND ')} ${order} LIMIT ? OFFSET ?`;
  return { sql, binds: [...values, limit, offset] };
}
