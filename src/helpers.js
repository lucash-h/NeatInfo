const DAY_MS = 86400000;

// §3 "Pull": an item whose fetch failed is not a dead end -- it is an item
// waiting for text. The duplicate payload answers with `has_text`; a full
// article carries `body_text`. A list row carries neither, and "unknown" must
// not be read as "missing" -- offering to fill in an article that already has
// text is worse than not offering at all.
export function needsText(article) {
  if (!article) return false;
  if (article.fetch_status === 'pasted') return false;
  if ('has_text' in article) return !article.has_text;
  if (article.body_text === undefined) return false;
  return !article.body_text;
}

export function daysSince(iso) {
  const then = new Date(iso);
  then.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / DAY_MS);
}

export function readMinutes(article) {
  if (!article.word_count) return null;
  return Math.max(1, Math.round(article.word_count / 230));
}

export function metaLine(article) {
  const parts = [article.source];
  const when = article.published_at || article.added_at;
  if (when) {
    const d = new Date(when);
    if (!Number.isNaN(d.getTime())) {
      parts.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    }
  }
  const mins = readMinutes(article);
  if (mins) parts.push(`${mins} min`);
  return parts.join(' · ');
}

export function ageLabel(article) {
  const days = daysSince(article.added_at);
  if (days <= 0) return 'added today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

export function lapseInfo(article, lapseWindowDays) {
  const days = daysSince(article.added_at);
  if (days <= 0) return null;
  const left = lapseWindowDays - days;
  return {
    label: left <= 0 ? 'lapsing' : `lapses in ${left}d`,
    urgent: left <= 4,
  };
}

// ------------------------------------------------------- archive filters
//
// §3 "Store" lists date range, source, tag, status and favorite. Every one of
// them is a server-side filter without exception -- Starred included, which
// used to be a client-side pass over whatever page had loaded and therefore
// lied past the first page. The mapping from UI state to query string lives
// here, in plain JS, so it can be tested without rendering React.

export const EMPTY_FILTERS = {
  status: 'all',
  favorite: false,
  source: '',
  tag: '',
  from: '',
  to: '',
};

// A page small enough to paint instantly; "Load more" walks the rest. §2.2
export const ARCHIVE_PAGE = 50;

export function archiveQueryString({
  dayStart,
  filter = 'all',
  query = '',
  filters = EMPTY_FILTERS,
  surface = 'archive',
  offset = 0,
  limit = ARCHIVE_PAGE,
}) {
  const params = new URLSearchParams({ dayStart, filter, q: query });
  const f = { ...EMPTY_FILTERS, ...filters };

  if (f.status && f.status !== 'all') params.set('status', f.status);
  // Starred is a surface in the nav and a filter on the wire.
  if (f.favorite || surface === 'starred') params.set('favorite', '1');
  if (f.source) params.set('source', f.source);
  if (f.tag) params.set('tag', f.tag);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);

  params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));

  return params.toString();
}

// What the archive says it is filtered by, so "N of M" is never mysterious.
// Returns one entry per active filter, each clearable on its own.
export function activeFilters(filters = EMPTY_FILTERS, surface = 'archive') {
  const f = { ...EMPTY_FILTERS, ...filters };
  const out = [];
  if (f.status && f.status !== 'all') out.push({ key: 'status', label: f.status });
  // On Starred the favorite filter is the surface itself, so it is not
  // offered as something to clear.
  if (f.favorite && surface !== 'starred') out.push({ key: 'favorite', label: 'starred' });
  if (f.source) out.push({ key: 'source', label: f.source });
  if (f.tag) out.push({ key: 'tag', label: '#' + f.tag });
  if (f.from) out.push({ key: 'from', label: 'from ' + f.from });
  if (f.to) out.push({ key: 'to', label: 'to ' + f.to });
  return out;
}
