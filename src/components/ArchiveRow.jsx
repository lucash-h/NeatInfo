import { useApp } from '../AppContext';
import { metaLine } from '../helpers';

export default function ArchiveRow({ article }) {
  const { open } = useApp();

  return (
    <button className="archive-row" onClick={() => open(article.id)}>
      <div className="card-line">
        <span className={`status-tag ${article.status}`}>{article.status}</span>
        {article.favorite && <span style={{ color: 'var(--star)', fontSize: '13px' }}>★</span>}
      </div>
      <span className="archive-title">{article.title}</span>
      <span className="card-meta">{metaLine(article)}</span>
    </button>
  );
}
