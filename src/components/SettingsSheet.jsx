import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../AppContext';

export default function SettingsSheet({ visible, onClose }) {
  const { feed, load, toast } = useApp();
  const [value, setValue] = useState(feed.lapseWindowDays);

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
        <div className="sheet-alt">
          <a className="link-btn" href="/api/export">Export everything as JSON</a>
          <button className="link-btn muted" type="button" onClick={signOut}>Sign out</button>
        </div>
      </form>
    </div>
  );
}
