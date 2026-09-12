import { useState, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../AppContext';

// Two days rather than one: a single missed night is a runner hiccup, two is a
// pattern worth noticing.
const STALE_MS = 48 * 60 * 60 * 1000;

function isStale(iso) {
  const then = new Date(iso).getTime();
  return Number.isFinite(then) && Date.now() - then > STALE_MS;
}

function describeAge(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'at an unknown time';
  const hours = Math.floor((Date.now() - then) / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export default function SettingsSheet({ visible, onClose }) {
  const { feed, load, toast } = useApp();
  const [value, setValue] = useState(feed.lapseWindowDays);
  // What R2 is actually holding, measured when the sheet opens. §5.2
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    if (!visible) return;
    api('/api/settings').then(setUsage).catch(() => {});
  }, [visible]);

  if (!visible) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ lapseWindowDays: Number(value) }),
      });
    } catch (err) {
      toast(err.message);
      return;
    }
    onClose();
    toast('Saved');
    await load();
  }

  async function signOut() {
    // A failed sign-out still means signing out locally.
    await api('/api/session', { method: 'DELETE' }).catch(() => {});
    location.reload();
  }

  return (
    <div className="sheet-scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="sheet" onSubmit={handleSubmit}>
        <div className="sheet-head">
          <span className="sheet-title">Settings</span>
          <button className="link-btn muted" type="button" onClick={onClose}>Close</button>
        </div>
        <label className="field">
          <span className="field-label">Lapse window</span>
          <span className="field-hint">
            Anything in Pending this long archives itself as lapsed. Still searchable.
          </span>
          <input className="input" type="number" min={1} max={365} step={1}
            value={value} onChange={e => setValue(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-tall" type="submit">Save</button>
        {/* The pipeline runs nightly somewhere else, and its failure mode is
            silence -- it simply stops and nothing says so (§9.6). This is
            where you would look, which is why the age is spelled out rather
            than left as a timestamp to subtract in your head. */}
        {usage && (
          <p className="field-hint">
            {usage.pipelineLastRun
              ? `Features · ${usage.pipelineLastCount} scored ${describeAge(usage.pipelineLastRun)} at ${usage.pipelineVersion}`
              : 'Features · the scoring pipeline has not run yet'}
            {usage.pipelineLastRun && isStale(usage.pipelineLastRun) && ' — that is longer ago than nightly'}
          </p>
        )}

        {usage && usage.r2UsageMb !== null && (
          <p className="field-hint">
            Raw page copies in R2 · {usage.r2UsageMb} MB of {Math.round(usage.r2BudgetMb / 1024)} GB
          </p>
        )}
        <div className="sheet-alt">
          <a className="link-btn" href="/api/export">Export everything as JSON</a>
          <button className="link-btn muted" type="button" onClick={signOut}>Sign out</button>
        </div>
      </form>
    </div>
  );
}
