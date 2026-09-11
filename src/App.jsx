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
import Shortcuts from './components/Shortcuts';
import Toast from './components/Toast';

function Shell() {
  const { feed, surface, switchSurface, load, openArticle, step, resolve, close, showTag, filters, archiveRows } = useApp();
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

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

  // Keyboard shortcuts. V1-22 rebound k/l to e/k: `k` used to mean Keep here,
  // but every reader app anyone has muscle memory from (vim, Gmail, Reader)
  // uses `k` for "previous item" and `j` for "next" -- so `k` is previous now,
  // `l` is gone, and Keep moved to `e`. Do not "helpfully" put Keep back on
  // `k`; that's the collision this rebind exists to fix.
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const t = e.target;
      // The old guard only checked INPUT/TEXTAREA, which missed a <select>
      // (the Archive filter dropdowns) and a contentEditable region.
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;

      if (e.key === 'Escape') {
        // Esc is the one key that still fires while typing -- it's the way
        // out of the search box that `/` focuses.
        if (typing) { t.blur(); return; }
        if (helpOpen) { setHelpOpen(false); return; }
        if (addOpen) { setAddOpen(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (openArticle) { close(); return; }
        return;
      }

      if (typing) return;

      // Bug fix: previously only Escape checked for an open sheet, so e.g.
      // clicking a button inside the Add sheet left j/k/s/x still stepping or
      // resolving the article behind it. Nothing but Escape gets past here
      // while a sheet or this help overlay is open.
      // `?` is the exception: it toggles, so it has to survive its own guard.
      if (helpOpen && e.key === '?') { setHelpOpen(false); return; }
      if (helpOpen || addOpen || settingsOpen) return;

      if (e.key === '?') { setHelpOpen(true); return; }
      if (e.key === 'a') { setAddOpen(true); return; }

      if (e.key === '/') {
        e.preventDefault();
        // Only Archive/Starred render a search box. Rather than doing
        // nothing on Today/Pending, hop to the archive first -- `/` is meant
        // to be "go search," not "search, but only from the one surface that
        // has it."
        if (surface !== 'archive' && surface !== 'starred') switchSurface('archive');
        requestAnimationFrame(() => {
          document.querySelector('.surface input[type="search"]')?.focus();
        });
        return;
      }

      if (e.key === 'j') { e.preventDefault(); step(1); return; }
      if (e.key === 'k') { e.preventDefault(); step(-1); return; }

      // e/s/x only apply to an item still undecided, matching the Keep/★/
      // Dismiss buttons in Reader, which are likewise hidden once resolved.
      if (openArticle?.status === 'new') {
        if (e.key === 'e') { e.preventDefault(); resolve(openArticle.id, 'kept', false); return; }
        if (e.key === 's') { e.preventDefault(); resolve(openArticle.id, 'kept', true); return; }
        if (e.key === 'x') { e.preventDefault(); resolve(openArticle.id, 'dismissed', false); return; }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [addOpen, settingsOpen, helpOpen, openArticle, step, resolve, close, surface, switchSurface]);

  // Register service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Collect tags across the loaded surfaces. The archive's own tag list comes
  // from /api/facets (it covers rows no page has loaded); this rail is the
  // shortcut to whatever is currently in view.
  const tags = new Set();
  [feed.today, feed.pending, archiveRows].forEach(list => {
    list.forEach(a => (a.tags || []).forEach(t => tags.add(t)));
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
            {/* A tag is a filter on the archive, not a label. §3 "Store" */}
            {[...tags].sort().slice(0, 12).map(t => (
              <button
                key={t}
                className="tag"
                aria-pressed={String(filters.tag === t)}
                onClick={() => showTag(t)}
              >{t}</button>
            ))}
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
      <Shortcuts visible={helpOpen} onClose={() => setHelpOpen(false)} />
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
