import { useApp } from '../AppContext';
import { metaLine, ageLabel, lapseInfo } from '../helpers';

export default function ArticleCard({ article, showLapse = false }) {
  const { open, resolve, feed } = useApp();
  const lapse = showLapse ? lapseInfo(article, feed.lapseWindowDays) : null;

  return (
    <article className="card">
      {showLapse ? (
        <div className="card-head">
          <span className="card-meta">{metaLine(article)}</span>
          {lapse && <span className={`chip${lapse.urgent ? ' urgent' : ''}`}>{lapse.label}</span>}
        </div>
      ) : (
        <div className="card-meta">{metaLine(article)}</div>
      )}

      <h3 className="card-title" style={{ cursor: 'pointer' }} onClick={() => open(article.id)}>
        {article.title}
      </h3>

      {showLapse ? (
        <div className="card-line">
          <span>{ageLabel(article)}</span>
          <span>·</span>
          <span>{article.opened_at ? 'opened, undecided' : 'never opened'}</span>
        </div>
      ) : article.summary ? (
        <p className="card-summary">{article.summary}</p>
      ) : null}

      {article.fetch_status && article.fetch_status !== 'ok' && article.fetch_status !== 'pasted' && (
        <div className="card-line">
          <span>no text captured — open the link, or paste it in</span>
        </div>
      )}

      <div className="actions">
        <button className="btn btn-keep" onClick={() => resolve(article.id, 'kept', false)}>Keep</button>
        <button
          className="btn btn-icon"
          title="Keep and star"
          aria-pressed={String(Boolean(article.favorite))}
          onClick={() => resolve(article.id, 'kept', true)}
        >★</button>
        <button className="btn btn-dismiss" onClick={() => resolve(article.id, 'dismissed', false)}>Dismiss</button>
        {!showLapse && (
          <button
            className="btn btn-icon"
            style={{ fontSize: '13px', color: 'var(--secondary)' }}
            onClick={() => open(article.id)}
          >Read</button>
        )}
      </div>
    </article>
  );
}
