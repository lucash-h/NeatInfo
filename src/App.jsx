import { useState, useEffect, useCallback } from 'react';
import { api, onUnauthorized } from './api';
import { AppProvider, useApp } from './AppContext';
import Gate from './components/Gate';
import Today from './components/Today';
import Pending from './components/Pending';
import Archive from './components/Archive';
import Reader from './components/Reader';
import AddSheet from './components/AddSheet';
import SettingsSheet from './components/SettingsSheet';
import Toast from './components/Toast';

function Shell() {
  const { feed, surface, switchSurface, load, openArticle, step, resolve, close } = useApp();
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // `load` swallows its own failures into a toast, so this cannot reject.
  useEffect(() => { load(); }, []);

  // Share-target: /?url=…
  useEffect(() => {
    const shared = new URLSearchParams(location.search).get('url');
    if (shared) {
      history.replaceState(null, '', '/');
      setAddOpen(true);
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (addOpen) { setAddOpen(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (openArticle) { close(); return; }
      }

      if (e.key === 'j') { e.preventDefault(); step(1); }
      if (e.key === 'l') { e.preventDefault(); step(-1); }

      if (openArticle?.status === 'new') {
        if (e.key === 'k') { e.preventDefault(); resolve(openArticle.id, 'kept', false); }
        if (e.key === 's') { e.preventDefault(); resolve(openArticle.id, 'kept', true); }
        if (e.key === 'x') { e.preventDefault(); resolve(openArticle.id, 'dismissed', false); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [addOpen, settingsOpen, openArticle, step, resolve, close]);

  // Register service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Collect tags across all feeds
  const tags = new Set();
  ['today', 'pending', 'archive'].forEach(k => {
    feed[k].forEach(a => (a.tags || []).forEach(t => tags.add(t)));
  });

  const surfaceComponent = {
    today: <Today />,
    pending: <Pending />,
    archive: <Archive />,
    starred: <Archive starredOnly />,
  }[surface] || <Today />;

  function NavBtn({ name, children }) {
    return (
      <button
        className="rail-link"
        aria-current={String(surface === name)}
        onClick={() => switchSurface(name)}
      >{children}</button>
    );
  }

  function TabBtn({ name, children }) {
    return (
      <button
        className="tab"
        aria-current={String(surface === name)}
        onClick={() => switchSurface(name)}
      >{children}</button>
    );
  }

  return (
    <div className="app">
      {/* Desktop rail */}
      <nav className="rail">
        <span className="wordmark">NeatInfo</span>
        <button className="btn btn-primary rail-add" onClick={() => setAddOpen(true)}>Add article</button>
        <div className="rail-nav">
          <NavBtn name="today">Today <span className="count">{feed.today.length}</span></NavBtn>
          <NavBtn name="pending">Pending <span className="count">{feed.pendingTotal}</span></NavBtn>
          <NavBtn name="archive">Archive</NavBtn>
          <NavBtn name="starred">Starred</NavBtn>
        </div>
        <div className="rail-tags">
          <span className="eyebrow">Tags</span>
          <div className="tag-row">
            {[...tags].sort().slice(0, 12).map(t => <span key={t} className="tag">{t}</span>)}
          </div>
        </div>
        <div className="rail-foot">
          <button className="rail-meta" onClick={() => setSettingsOpen(true)}>
            Lapse window · {feed.lapseWindowDays} days
          </button>
          <a className="rail-export" href="/api/export">Export JSON</a>
        </div>
      </nav>

      <main className="main">
        {/* Mobile topbar */}
        <header className="topbar">
          <span className="wordmark">NeatInfo</span>
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>Add</button>
        </header>

        <div className="tabs">
          <TabBtn name="today">Today <span className="count">{feed.today.length}</span></TabBtn>
          <TabBtn name="pending">Pending <span className="count">{feed.pendingTotal}</span></TabBtn>
          <TabBtn name="archive">Archive</TabBtn>
        </div>

        <div className="surface">
          {surfaceComponent}
        </div>
      </main>

      <Reader />
      <AddSheet visible={addOpen} onClose={() => setAddOpen(false)} />
      <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toast />
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(null);

  // A session cookie expires at 90 days, so a 401 will happen in normal use.
  // api.js reports it here, from wherever it occurred, and the Gate takes over
  // instead of the screen going blank. §9.1
  useEffect(() => onUnauthorized(() => setAuthed(false)), []);

  useEffect(() => {
    api('/api/session').then(d => setAuthed(d.authed)).catch(() => setAuthed(false));
  }, []);

  if (authed === null) return null;
  if (!authed) return <Gate onAuth={() => setAuthed(true)} />;

  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
