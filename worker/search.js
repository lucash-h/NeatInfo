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

// ------------------------------------------------------------- filters
//
// §3 "Store" asks for date range, source, tag, status and favorite. They are
// parsed here rather than in the router so the rules -- what is a legal
// status, how a date bound is widened to cover a whole day -- are stated once
// and can be tested without going through a request. Nothing a user types is
// ever interpolated into SQL: every value below leaves as a bound `?`.

export const ARCHIVE_STATUSES = ['kept', 'dismissed', 'lapsed'];

// A page small enough to render instantly, and a ceiling so `?limit=100000`
// cannot ask D1 for the whole archive in one row set. §2.2 "searchable
// forever" is served by paging, not by one enormous query.
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// `YYYY-MM-DD` from a date input, or a full ISO instant if a caller has one.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

// added_at is stored as a UTC ISO string, which sorts lexicographically, so a
// day bound is just the day padded to its first or last instant -- no date
// arithmetic, and the index on added_at still applies.
function dateBound(raw, end) {
  const value = String(raw).trim();
  if (DATE_ONLY.test(value)) return value + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z');
  if (ISO_INSTANT.test(value)) return value;
  return null;
}

function boolish(raw) {
  return raw === '1' || raw === 'true' || raw === 'yes';
}

// Reads the archive half of the /api/feed query string. Returns either
// `{ error }` -- so the router can answer 400 rather than quietly showing an
// unfiltered archive under a filter the user thinks is applied -- or the
// filter set plus the page window.
export function parseArchiveParams(searchParams) {
  const get = (k) => (searchParams.get(k) || '').trim();

  const filters = {};

  const status = get('status');
  if (status && status !== 'all') {
    if (!ARCHIVE_STATUSES.includes(status)) return { error: 'Unknown status filter.' };
    filters.status = status;
  }

  // Only the on state filters. An off toggle is "no favorite filter", not
  // "show me the unstarred" -- which is not a thing the UI offers.
  if (boolish(get('favorite'))) filters.favorite = true;

  const source = get('source');
  if (source) filters.source = source.slice(0, 200);

  const tag = get('tag');
  if (tag) filters.tag = tag.toLowerCase().slice(0, 100);

  const from = get('from');
  if (from) {
    const bound = dateBound(from, false);
    if (!bound) return { error: 'Bad "from" date.' };
    filters.from = bound;
  }

  const to = get('to');
  if (to) {
    const bound = dateBound(to, true);
    if (!bound) return { error: 'Bad "to" date.' };
    filters.to = bound;
  }

  const rawLimit = Number(get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const rawOffset = Number(get('offset'));
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  return { filters, limit, offset };
}

// Turns a parsed filter set into WHERE fragments written against the `a`
// alias, each with its own anonymous `?`.
export function archiveFilterClauses(filters = {}) {
  const clauses = [];
  const binds = [];

  if (filters.status) {
    clauses.push('a.status = ?');
    binds.push(filters.status);
  }
  if (filters.favorite) {
    clauses.push('a.favorite = 1');
  }
  if (filters.source) {
    clauses.push('a.source = ?');
    binds.push(filters.source);
  }
  if (filters.tag) {
    // EXISTS rather than a JOIN so an article carrying the tag twice cannot
    // duplicate the row or corrupt the count.
    clauses.push(
      `EXISTS (SELECT 1 FROM article_tag at JOIN tag t ON t.id = at.tag_id
               WHERE at.article_id = a.id AND t.name = ?)`
    );
    binds.push(filters.tag);
  }
  if (filters.from) {
    clauses.push('a.added_at >= ?');
    binds.push(filters.from);
  }
  if (filters.to) {
    clauses.push('a.added_at <= ?');
    binds.push(filters.to);
  }

  return { clauses, binds };
}

// The WHERE shared by the row query and the count, so a filtered total can
// never disagree with the rows it is counting.
function archiveWhere({ topicId, match, filters, clauses = [], binds = [] }) {
  const where = [];
  const values = [];

  if (match) {
    where.push('article_fts MATCH ?');
    values.push(match);
  }

  where.push('a.topic_id = ?');
  values.push(topicId);
  where.push(`a.status != 'new'`);

  const parsed = archiveFilterClauses(filters);
  for (const clause of parsed.clauses) where.push(clause);
  values.push(...parsed.binds);

  // Extra filters supplied by the caller, already written against the `a`
  // alias with their own `?` placeholders.
  for (const clause of clauses) where.push(clause);
  values.push(...binds);

  const from = match
    ? `FROM article_fts f JOIN article a ON a.id = f.rowid`
    : `FROM article a`;

  return { where: where.join(' AND '), values, from };
}

// One place that builds the archive query, so filters (§3 "Store": date range,
// source, tag, status, favorite) compose onto it without re-deriving the
// search half. Conditions are anonymous `?` placeholders in a flat array,
// which is what makes appending a clause a one-liner.
export function buildArchiveQuery({
  columns,
  topicId,
  match = null,
  limit = DEFAULT_LIMIT,
  offset = 0,
  filters = {},
  clauses = [],
  binds = []
}) {
  const { where, values, from } = archiveWhere({ topicId, match, filters, clauses, binds });
  const cols = columns.split(',').map((c) => 'a.' + c.trim()).join(', ');
  const order = match ? 'ORDER BY rank' : 'ORDER BY COALESCE(a.resolved_at, a.added_at) DESC';

  const sql = `SELECT ${cols} ${from} WHERE ${where} ${order} LIMIT ? OFFSET ?`;
  return { sql, binds: [...values, limit, offset] };
}

// The same predicate without the page window: how many rows the filter set
// actually matches, which is the only honest number to put next to a page of
// 50. Success criterion 8.
export function buildArchiveCount({ topicId, match = null, filters = {}, clauses = [], binds = [] }) {
  const { where, values, from } = archiveWhere({ topicId, match, filters, clauses, binds });
  return { sql: `SELECT COUNT(*) AS n ${from} WHERE ${where}`, binds: values };
}
