import { useRef, useCallback } from 'react';
import { useApp } from '../AppContext';
import ArchiveRow from './ArchiveRow';

export default function Archive({ starredOnly = false }) {
  const { feed, query, setQuery, load } = useApp();
  const timerRef = useRef();

  const rows = starredOnly ? feed.archive.filter(a => a.favorite) : feed.archive;

  const handleSearch = useCallback((e) => {
    const value = e.target.value;
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      load({ query: value.trim() });
    }, 250);
  }, [setQuery, load]);

  return (
    <div className="stack">
      <input
        className="input"
        type="search"
        placeholder="Search titles, body, notes"
        value={query}
        onChange={handleSearch}
      />
      <div className="dateline">
        {rows.length} of {feed.archiveTotal} · nothing deleted
      </div>
      {rows.map(a => <ArchiveRow key={a.id} article={a} />)}
      <div className="archive-foot">
        <span>Nothing is ever deleted, only demoted.</span>
        <a href="/api/export">Export JSON</a>
      </div>
    </div>
  );
}
