import { useRef, useCallback, useEffect } from 'react';
import { useApp } from '../AppContext';
import { activeFilters, archiveEmptyState } from '../helpers';
import ArchiveRow from './ArchiveRow';

// §3 "Store" asks for filters over date range, source, tag, status and
// favorite. Every control here writes one server-side filter -- nothing is
// applied to the loaded rows -- so what the count says and what the list shows
// are the same thing however many pages deep you are.
const STATUS_CHIPS = [
  ['all', 'All'],
  ['kept', 'Kept'],
  ['dismissed', 'Dismissed'],
  ['lapsed', 'Lapsed'],
];

export default function Archive({ starredOnly = false }) {
  const {
    archiveRows, feed, query, setQuery, load, loadMore, loadingMore,
    filters, facets, loadFacets, setArchiveFilter, clearFilters, surface,
    loading, initialLoading,
  } = useApp();
  const timerRef = useRef();

  // The sources and tags to offer come from the whole archive, not from the
  // page that happens to be loaded. §3 "Store"
  useEffect(() => { loadFacets(); }, [loadFacets]);

  const handleSearch = useCallback((e) => {
    const value = e.target.value;
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      load({ query: value.trim() });
    }, 250);
  }, [setQuery, load]);

  const applied = activeFilters(filters, surface);
  // Null when there are rows, so the JSX below stays a plain conditional.
  const empty = archiveEmptyState({ surface, filters, query, archiveTotal: feed.archiveTotal });
  const searching = Boolean(query.trim());
  const hasMore = archiveRows.length < feed.archiveTotal;
  const dateFloor = facets.earliestAddedAt ? facets.earliestAddedAt.slice(0, 10) : undefined;

  return (
    <div className="stack">
      <input
        className="input"
        type="search"
        placeholder="Search titles, body, notes"
        value={query}
        onChange={handleSearch}
      />

      <div className="filterbar">
        <div className="filters">
          {STATUS_CHIPS.map(([value, label]) => (
            <button
              key={value}
              className="filter"
              aria-pressed={String((filters.status || 'all') === value)}
              onClick={() => setArchiveFilter({ status: value })}
            >{label}</button>
          ))}
          {/* On Starred the favorite filter is the surface itself, so the
              toggle would be a control that cannot be turned off. */}
          {!starredOnly && (
            <button
              className="filter"
              aria-pressed={String(Boolean(filters.favorite))}
              onClick={() => setArchiveFilter({ favorite: !filters.favorite })}
            >★ Starred</button>
          )}
        </div>

        <div className="filter-selects">
          <select
            className="select"
            aria-label="Source"
            value={filters.source || ''}
            onChange={(e) => setArchiveFilter({ source: e.target.value })}
          >
            <option value="">Any source</option>
            {facets.sources.map(s => (
              <option key={s.name} value={s.name}>{s.name} ({s.count})</option>
            ))}
          </select>

          <select
            className="select"
            aria-label="Tag"
            value={filters.tag || ''}
            onChange={(e) => setArchiveFilter({ tag: e.target.value })}
          >
            <option value="">Any tag</option>
            {facets.tags.map(t => (
              <option key={t.name} value={t.name}>{t.name} ({t.count})</option>
            ))}
          </select>

          <label className="date-field">
            <span>From</span>
            <input
              className="select"
              type="date"
              min={dateFloor}
              value={filters.from || ''}
              onChange={(e) => setArchiveFilter({ from: e.target.value })}
            />
          </label>

          <label className="date-field">
            <span>To</span>
            <input
              className="select"
              type="date"
              min={dateFloor}
              value={filters.to || ''}
              onChange={(e) => setArchiveFilter({ to: e.target.value })}
            />
          </label>
        </div>
      </div>

      {initialLoading ? (
        <div className="empty loading-state">Loading…</div>
      ) : (
        <>
          <div className="dateline archive-count">
            <span>
              {archiveRows.length} of {feed.archiveTotal}
              {applied.length || searching
                ? ` · filtered by ${[...applied.map(f => f.label), ...(searching ? [`"${query.trim()}"`] : [])].join(', ')}`
                : ' · nothing deleted'}
              {loading && ' · loading…'}
            </span>
            {(applied.length || searching) && (
              <button className="link-btn" onClick={clearFilters}>Clear</button>
            )}
          </div>

          {!archiveRows.length ? (
            empty && (
              <div className="empty">
                <span className="empty-title">{empty.title}</span>
                <span className="empty-note">{empty.note}</span>
              </div>
            )
          ) : (
            archiveRows.map(a => <ArchiveRow key={a.id} article={a} />)
          )}

          {hasMore && (
            <button className="btn load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : `Load more (${feed.archiveTotal - archiveRows.length} left)`}
            </button>
          )}
        </>
      )}

      <div className="archive-foot">
        <span>Nothing is ever deleted, only demoted.</span>
        <a href="/api/export">Export JSON</a>
      </div>
    </div>
  );
}
