import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { api, localDayStart } from './api';

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

  const load = useCallback(async (opts = {}) => {
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
  }, [query, filter]);

  const switchSurface = useCallback((name) => {
    setSurface(name);
    setQuery('');
    setOpenArticle(null);
  }, []);

  const open = useCallback(async (id) => {
    const { article } = await api(`/api/articles/${id}`);
    setOpenArticle(article);
    if (!article.opened_at) {
      api(`/api/articles/${id}/open`, { method: 'POST' }).catch(() => {});
    }
  }, []);

  const resolve = useCallback(async (id, status, favorite) => {
    await api(`/api/articles/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status, favorite }),
    });
    toast(favorite ? 'Starred and archived' : status === 'kept' ? 'Kept' : 'Dismissed');
    setOpenArticle(null);
    await load();
  }, [load, toast]);

  const toggleStar = useCallback(async (id, favorite) => {
    await api(`/api/articles/${id}/star`, {
      method: 'POST',
      body: JSON.stringify({ favorite }),
    });
    const data = await load();
    const all = [...data.today, ...data.pending, ...data.archive];
    const updated = all.find(a => a.id === id);
    if (updated) setOpenArticle(updated);
  }, [load]);

  const saveNote = useCallback(async (id, notes) => {
    await api(`/api/articles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
    toast('Note saved');
  }, [toast]);

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
