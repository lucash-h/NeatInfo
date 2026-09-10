import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { api, localDayStart, ApiError } from './api';

const AppContext = createContext();

export function useApp() {
  return useContext(AppContext);
}

const EMPTY_FEED = {
  today: [], pending: [], archive: [],
  pendingTotal: 0, archiveTotal: 0, lapseWindowDays: 14,
};

export function AppProvider({ children }) {
  const [feed, setFeed] = useState(EMPTY_FEED);
  const [surface, setSurface] = useState('today');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [openArticle, setOpenArticle] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimer = useRef();

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  // Every action below goes through this. A 401 is already being handled by
  // the Gate (api.js calls the unauthorized handler), so it is swallowed here
  // rather than toasted on the way out; anything else becomes a toast and the
  // caller gets `undefined` instead of an unhandled rejection. §9.1
  const guard = useCallback(async (work, fallback) => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return undefined;
      toast(err?.message || fallback || 'Something went wrong.');
      return undefined;
    }
  }, [toast]);

  // The last net: a rejection that escapes anyway is reported rather than
  // logged silently to a console nobody has open.
  useEffect(() => {
    function onRejection(event) {
      const err = event.reason;
      if (err instanceof ApiError && err.status === 401) return;
      toast(err?.message || 'Something went wrong.');
    }
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [toast]);

  const load = useCallback((opts = {}) => guard(async () => {
    const searchQuery = opts.query ?? query;
    const searchFilter = opts.filter ?? filter;
    const params = new URLSearchParams({
      dayStart: localDayStart(),
      filter: searchFilter,
      q: searchQuery,
    });
    const data = await api(`/api/feed?${params}`);
    setFeed(data);
    return data;
  }, 'Could not load the feed.'), [query, filter, guard]);

  const switchSurface = useCallback((name) => {
    setSurface(name);
    setQuery('');
    setOpenArticle(null);
  }, []);

  const open = useCallback((id) => guard(async () => {
    const { article } = await api(`/api/articles/${id}`);
    setOpenArticle(article);
    if (!article.opened_at) {
      // Fire-and-forget, but never unhandled: failing to record opened_at is
      // not worth a toast.
      api(`/api/articles/${id}/open`, { method: 'POST' }).catch(() => {});
    }
    return article;
  }, 'Could not open that one.'), [guard]);

  const resolve = useCallback((id, status, favorite) => guard(async () => {
    await api(`/api/articles/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status, favorite }),
    });
    toast(favorite ? 'Starred and archived' : status === 'kept' ? 'Kept' : 'Dismissed');
    setOpenArticle(null);
    await load();
  }, 'Could not save that decision.'), [load, toast, guard]);

  const toggleStar = useCallback((id, favorite) => guard(async () => {
    await api(`/api/articles/${id}/star`, {
      method: 'POST',
      body: JSON.stringify({ favorite }),
    });
    const data = await load();
    if (!data) return;
    const all = [...data.today, ...data.pending, ...data.archive];
    const updated = all.find(a => a.id === id);
    if (updated) setOpenArticle(updated);
  }, 'Could not change the star.'), [load, guard]);

  const saveNote = useCallback((id, notes) => guard(async () => {
    await api(`/api/articles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
    toast('Note saved');
  }, 'Could not save the note.'), [toast, guard]);

  const close = useCallback(() => {
    setOpenArticle(null);
  }, []);

  const currentList = useCallback(() => {
    if (surface === 'today') return feed.today;
    if (surface === 'pending') return feed.pending;
    if (surface === 'starred') return feed.archive.filter(a => a.favorite);
    return feed.archive;
  }, [surface, feed]);

  const step = useCallback((delta) => {
    const list = currentList();
    if (!list.length) return;
    const idx = openArticle ? list.findIndex(a => a.id === openArticle.id) : -1;
    const target = list[Math.max(0, Math.min(list.length - 1, idx === -1 ? 0 : idx + delta))];
    if (target) open(target.id);
  }, [currentList, openArticle, open]);

  const value = {
    feed, surface, filter, query, openArticle, toastMsg,
    load, switchSurface, setFilter, setQuery, open, close,
    resolve, toggleStar, saveNote, toast, step, currentList,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
