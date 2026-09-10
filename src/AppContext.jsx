import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { api, localDayStart, ApiError } from './api';
import { getPlayer } from './tts';
import { ARCHIVE_PAGE, EMPTY_FILTERS, archiveQueryString } from './helpers';

const AppContext = createContext();

export function useApp() {
  return useContext(AppContext);
}

const EMPTY_FEED = {
  today: [], pending: [], archive: [],
  pendingTotal: 0, archiveTotal: 0, lapseWindowDays: 14,
};

const EMPTY_FACETS = { sources: [], tags: [], earliestAddedAt: null };

export function AppProvider({ children }) {
  const [feed, setFeed] = useState(EMPTY_FEED);
  const [surface, setSurface] = useState('today');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  // §3 "Store" filters. They are server-side, so they live next to the feed
  // rather than being applied to whatever rows happen to be loaded.
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [facets, setFacets] = useState(EMPTY_FACETS);
  // The archive is paged, so its rows accumulate across "Load more" while the
  // rest of the feed is replaced wholesale on every load.
  const [archiveRows, setArchiveRows] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
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

  // Any load is page one: a filter or a search that kept the old offset would
  // show a slice of a result set the user is no longer looking at.
  const load = useCallback((opts = {}) => guard(async () => {
    const params = archiveQueryString({
      dayStart: localDayStart(),
      filter: opts.filter ?? filter,
      query: opts.query ?? query,
      filters: opts.filters ?? filters,
      surface: opts.surface ?? surface,
      offset: 0,
      limit: ARCHIVE_PAGE,
    });
    const data = await api(`/api/feed?${params}`);
    setFeed(data);
    setArchiveRows(data.archive);
    return data;
  }, 'Could not load the feed.'), [query, filter, filters, surface, guard]);

  // The next page, appended. The total beside the rows is the server's
  // filtered count, so "N of M" stays honest however far down this goes. §2.2
  const loadMore = useCallback(() => guard(async () => {
    if (loadingMore) return undefined;
    setLoadingMore(true);
    try {
      const params = archiveQueryString({
        dayStart: localDayStart(),
        filter,
        query,
        filters,
        surface,
        offset: archiveRows.length,
        limit: ARCHIVE_PAGE,
      });
      const data = await api(`/api/feed?${params}`);
      // A row already on screen must not appear twice if something was
      // archived between the two reads.
      const seen = new Set(archiveRows.map((a) => a.id));
      setFeed((prev) => ({ ...prev, archiveTotal: data.archiveTotal }));
      setArchiveRows((prev) => [...prev, ...data.archive.filter((a) => !seen.has(a.id))]);
      return data;
    } finally {
      setLoadingMore(false);
    }
  }, 'Could not load more.'), [archiveRows, filter, query, filters, surface, loadingMore, guard]);

  // The filter bar needs the whole archive's sources and tags, not one page's.
  const loadFacets = useCallback(() => guard(async () => {
    const data = await api('/api/facets');
    setFacets(data);
    return data;
  }, 'Could not load the filter options.'), [guard]);

  // One filter changed: merge it in and re-read from page one.
  const setArchiveFilter = useCallback((patch) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    load({ filters: next });
  }, [filters, load]);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setQuery('');
    load({ filters: EMPTY_FILTERS, query: '' });
  }, [load]);

  const switchSurface = useCallback((name) => {
    getPlayer().stop();
    setSurface(name);
    setQuery('');
    setFilters(EMPTY_FILTERS);
    setOpenArticle(null);
    // Starred is favorite=1 server-side, so leaving Archive changes the query
    // as well as the tab -- the rows have to be re-read either way.
    load({ surface: name, query: '', filters: EMPTY_FILTERS });
  }, [load]);

  // A tag in the rail is a filter, not decoration. §3 "Store"
  const showTag = useCallback((tag) => {
    getPlayer().stop();
    setSurface('archive');
    setOpenArticle(null);
    const next = { ...EMPTY_FILTERS, tag };
    setFilters(next);
    load({ surface: 'archive', filters: next, query });
  }, [load, query]);

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
    // Feed rows carry no `body_text`, so merge rather than replace: the reader
    // must not lose the article it is showing.
    if (updated) setOpenArticle(prev => (prev && prev.id === id ? { ...prev, ...updated } : updated));
  }, 'Could not change the star.'), [load, guard]);

  const saveNote = useCallback((id, notes) => guard(async () => {
    await api(`/api/articles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
    toast('Note saved');
  }, 'Could not save the note.'), [toast, guard]);

  // §3 "Pull": completing a failed fetch by hand, in place.
  const fillArticle = useCallback((id, fields) => guard(async () => {
    const { article, bodyTruncated } = await api(`/api/articles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
    setOpenArticle(article);
    // D1 will not hold more than ~1 MB in a value, so a very long paste is cut
    // at 512 KB rather than lost. Say so instead of silently keeping half. §5.2
    toast(bodyTruncated ? 'Saved — only the first 512 KB of that text was kept' : 'Filled in');
    await load();
    return article;
  }, 'Could not save that text.'), [guard, load, toast]);

  const refetch = useCallback((id) => guard(async () => {
    const result = await api(`/api/articles/${id}/refetch`, { method: 'POST' });
    if (result.fetchError) {
      toast(`Still no luck: ${result.fetchError}`);
    } else {
      toast('Fetched');
    }
    setOpenArticle(result.article);
    await load();
    return result;
  }, 'Could not fetch that again.'), [guard, load, toast]);

  const close = useCallback(() => {
    // Closing the reader must silence it, however it was closed -- the Back
    // button, Escape, or switching surface. §6
    getPlayer().stop();
    setOpenArticle(null);
  }, []);

  const currentList = useCallback(() => {
    if (surface === 'today') return feed.today;
    if (surface === 'pending') return feed.pending;
    // Starred filtered the loaded page here once, which made it wrong as soon
    // as there was more than one page. The server does it now.
    return archiveRows;
  }, [surface, feed, archiveRows]);

  const step = useCallback((delta) => {
    const list = currentList();
    if (!list.length) return;
    const idx = openArticle ? list.findIndex(a => a.id === openArticle.id) : -1;
    const target = list[Math.max(0, Math.min(list.length - 1, idx === -1 ? 0 : idx + delta))];
    if (target) open(target.id);
  }, [currentList, openArticle, open]);

  const value = {
    feed, surface, filter, query, openArticle, toastMsg,
    filters, facets, archiveRows, loadingMore,
    load, loadMore, loadFacets, setArchiveFilter, clearFilters, showTag,
    switchSurface, setFilter, setQuery, open, close,
    resolve, toggleStar, saveNote, toast, step, currentList,
    fillArticle, refetch,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
