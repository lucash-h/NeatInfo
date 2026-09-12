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

// -------------------------------------------------------- empty states
//
// V1-23: which empty message a surface shows is a decision, not a string
// literal, and it is the one part of this task that can be unit-tested --
// there is no jsdom here, so the components stay dumb renderers of whatever
// shape these return.

// Pending's total arrives unfiltered from the worker (`pendingTotal` counts
// every row with status='new' and added_at before today, before the
// opened/unopened split is applied -- see worker/index.js). That is what lets
// this tell "nothing pending, full stop" apart from "this filter has nothing
// under it" without a second round trip.
export function pendingEmptyState({ filter, pendingTotal }) {
  if (!pendingTotal) {
    return {
      title: 'Pending is empty.',
      note: 'Nothing is waiting on a decision. What you add yourself starts on Today; anything found for you waits here.',
    };
  }
  if (filter === 'opened') {
    return {
      title: 'Nothing opened yet.',
      note: 'Everything pending is still unopened. Try "Never opened", or clear the filter.',
    };
  }
  if (filter === 'unopened') {
    return {
      title: 'Nothing left unopened.',
      note: 'Everything pending has been opened at least once. Try "Opened", or clear the filter.',
    };
  }
  // The "all" filter and a nonzero total should always have rows to show; this
  // is only a fallback in case that ever stops being true.
  return { title: 'Nothing here.', note: 'Nothing matches this filter.' };
}

// Unlike Pending's, the archive's total (`archiveTotal`) is already counted
// under the active filters and search -- the worker's count query shares the
// same predicate as the row query (§2.2, §3 "Store"). So when nothing is
// active, that total IS the true, unfiltered count, and a zero there really
// means "nothing archived (or starred) yet" rather than "no matches."
export function archiveEmptyState({ surface, filters, query, archiveTotal }) {
  if (archiveTotal) return null;
  const hasFilters = activeFilters(filters, surface).length > 0;
  const term = (query || '').trim();
  const searching = Boolean(term);

  if (searching && hasFilters) {
    return {
      title: 'No matches.',
      note: `Nothing under the active filters matches "${term}". Clear the search or the filters to see more.`,
    };
  }
  if (searching) {
    return {
      title: 'No matches.',
      note: `Nothing matches "${term}". Clear the search to see everything here.`,
    };
  }
  if (hasFilters) {
    return {
      title: 'Nothing matches these filters.',
      note: 'Clear or widen the filters to see more.',
    };
  }
  if (surface === 'starred') {
    return {
      title: 'Nothing starred yet.',
      note: 'Star an article while reading it and it will show up here.',
    };
  }
  return {
    title: 'Archive is empty.',
    note: 'Kept, dismissed and lapsed articles collect here. Nothing has happened yet.',
  };
}
