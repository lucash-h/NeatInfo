import { useApp } from '../AppContext';
import ArticleCard from './ArticleCard';
import { pendingEmptyState } from '../helpers';

export default function Pending() {
  const { feed, filter, setFilter, load, loading, initialLoading } = useApp();

  const empty = pendingEmptyState({ filter, pendingTotal: feed.pendingTotal });

  function handleFilter(value) {
    setFilter(value);
    load({ filter: value });
  }

  return (
    <div className="stack">
      <p className="surface-note">
        Oldest first. Anything untouched for {feed.lapseWindowDays} days archives itself as lapsed — still searchable.
      </p>
      <div className="filters">
        {[['all', 'All'], ['opened', 'Opened'], ['unopened', 'Never opened']].map(([value, label]) => (
          <button
            key={value}
            className="filter"
            aria-pressed={String(filter === value)}
            onClick={() => handleFilter(value)}
          >{label}</button>
        ))}
      </div>
      {initialLoading ? (
        <div className="empty loading-state">Loading…</div>
      ) : !feed.pending.length ? (
        <div className="empty">
          <span className="empty-title">{empty.title}</span>
          <span className="empty-note">{empty.note}</span>
        </div>
      ) : (
        <>
          {loading && <div className="dateline loading-inline">Loading…</div>}
          {feed.pending.map(a => <ArticleCard key={a.id} article={a} showLapse />)}
        </>
      )}
    </div>
  );
}
