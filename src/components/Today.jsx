import { useApp } from '../AppContext';
import ArticleCard from './ArticleCard';

export default function Today() {
  const { feed, initialLoading } = useApp();
  const items = feed.today;
  const when = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="stack">
      <div className="dateline">
        {when} · {items.length} {items.length === 1 ? 'item left' : 'items left'}
      </div>
      {initialLoading ? (
        <div className="empty loading-state">Loading…</div>
      ) : !items.length ? (
        <div className="empty">
          <span className="empty-title">Today is clear.</span>
          <span className="empty-note">Nothing left to decide. Paste a URL, or leave it — tomorrow is a different set.</span>
        </div>
      ) : (
        items.map(a => <ArticleCard key={a.id} article={a} />)
      )}
    </div>
  );
}
