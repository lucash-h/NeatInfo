import { useApp } from '../AppContext';
import ArticleCard from './ArticleCard';

export default function Pending() {
  const { feed, filter, setFilter, load } = useApp();

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
      {!feed.pending.length ? (
        <div className="empty">Nothing waiting under this filter.</div>
      ) : (
        feed.pending.map(a => <ArticleCard key={a.id} article={a} showLapse />)
      )}
    </div>
  );
}
