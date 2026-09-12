import { useEffect } from 'react';
import { useApp } from '../AppContext';
import { ageLabel } from '../helpers';

export default function Discover() {
  const { candidates, loadCandidates, keepCandidate, skipCandidate, batchResolveCandidates } = useApp();

  useEffect(() => { loadCandidates(); }, []);

  if (!candidates.length) {
    return (
      <div className="empty">
        <h2>No candidates right now</h2>
        <p>The discovery pipeline runs every 6 hours. New candidates will appear here when the next batch arrives.</p>
      </div>
    );
  }

  function keepAll() {
    batchResolveCandidates(candidates.map(c => ({ id: c.id, action: 'keep' })));
  }

  function skipAll() {
    batchResolveCandidates(candidates.map(c => ({ id: c.id, action: 'skip' })));
  }

  return (
    <div className="discover">
      <div className="discover-head">
        <span className="discover-count">{candidates.length} candidates</span>
        <div className="discover-bulk">
          <button className="link-btn" onClick={keepAll}>Keep all</button>
          <button className="link-btn muted" onClick={skipAll}>Skip all</button>
        </div>
      </div>

      <div className="discover-list">
        {candidates.map(c => (
          <CandidateCard key={c.id} candidate={c} onKeep={keepCandidate} onSkip={skipCandidate} />
        ))}
      </div>
    </div>
  );
}

function CandidateCard({ candidate, onKeep, onSkip }) {
  const c = candidate;
  return (
    <div className="candidate-card">
      <div className="candidate-meta">
        <span className="candidate-source">{c.source}</span>
        {c.published_at && <span className="candidate-age">{ageLabel(c.published_at)}</span>}
        <span className="candidate-score" title="Relevance score">{c.score.toFixed(0)}</span>
      </div>
      <h3 className="candidate-title">{c.title}</h3>
      {c.summary && <p className="candidate-summary">{c.summary}</p>}
      <div className="candidate-actions">
        <button className="btn btn-primary btn-sm" onClick={() => onKeep(c.id)}>Keep</button>
        <button className="btn btn-sm" onClick={() => onSkip(c.id)}>Skip</button>
      </div>
    </div>
  );
}
