// Card metadata and the lapse countdown the Pending surface shows. §2.4, §3
import { describe, expect, it } from 'vitest';
import {
  ageLabel, daysSince, lapseInfo, metaLine, needsText, readMinutes,
  ARCHIVE_PAGE, EMPTY_FILTERS, activeFilters, archiveQueryString,
  pendingEmptyState, archiveEmptyState
} from '../src/helpers.js';
import { isoDaysAgo } from './helpers.js';

describe('readMinutes', () => {
  it('estimates at 230 wpm', () => {
    expect(readMinutes({ word_count: 230 })).toBe(1);
    expect(readMinutes({ word_count: 1150 })).toBe(5);
  });

  it('never rounds a real article down to zero minutes', () => {
    expect(readMinutes({ word_count: 12 })).toBe(1);
  });

  it('returns null when the body was never extracted', () => {
    expect(readMinutes({ word_count: 0 })).toBeNull();
    expect(readMinutes({})).toBeNull();
  });
});

describe('metaLine', () => {
  it('joins source, date and read time', () => {
    const line = metaLine({ source: 'example.com', published_at: '2026-03-04T12:00:00Z', word_count: 460 });
    expect(line.startsWith('example.com · ')).toBe(true);
    expect(line.endsWith(' · 2 min')).toBe(true);
  });

  it('falls back to added_at when there is no publish date', () => {
    const line = metaLine({ source: 'example.com', added_at: '2026-03-04T12:00:00Z', word_count: 0 });
    expect(line.split(' · ')).toHaveLength(2);
  });

  it('omits the read time for an article with no body', () => {
    expect(metaLine({ source: 'example.com', word_count: 0 })).toBe('example.com');
  });

  it('drops an unparseable date rather than printing "Invalid Date"', () => {
    expect(metaLine({ source: 'example.com', published_at: 'nonsense', word_count: 0 })).toBe('example.com');
  });
});

describe('daysSince and ageLabel', () => {
  it('reports today as 0 days', () => {
    expect(daysSince(new Date().toISOString())).toBe(0);
    expect(ageLabel({ added_at: new Date().toISOString() })).toBe('added today');
  });

  it('reports whole days for older items', () => {
    expect(daysSince(isoDaysAgo(1))).toBe(1);
    expect(ageLabel({ added_at: isoDaysAgo(1) })).toBe('1d ago');
    expect(ageLabel({ added_at: isoDaysAgo(6) })).toBe('6d ago');
  });
});

describe('lapseInfo', () => {
  it('says nothing about an item added today -- Today is not a guilt pile', () => {
    expect(lapseInfo({ added_at: new Date().toISOString() }, 14)).toBeNull();
  });

  it('counts down the remaining days', () => {
    expect(lapseInfo({ added_at: isoDaysAgo(1) }, 14)).toEqual({ label: 'lapses in 13d', urgent: false });
  });

  it('turns urgent in the last four days', () => {
    expect(lapseInfo({ added_at: isoDaysAgo(10) }, 14)).toEqual({ label: 'lapses in 4d', urgent: true });
  });

  it('reads "lapsing" once the window has run out', () => {
    expect(lapseInfo({ added_at: isoDaysAgo(20) }, 14)).toEqual({ label: 'lapsing', urgent: true });
  });

  it('respects a non-default window', () => {
    expect(lapseInfo({ added_at: isoDaysAgo(1) }, 30).label).toBe('lapses in 29d');
  });
});

// §3 "Pull": which items the reader and AddSheet offer to fill in.
describe('needsText', () => {
  it('is true for an article whose fetch failed', () => {
    expect(needsText({ fetch_status: '503', body_text: null })).toBe(true);
    expect(needsText({ fetch_status: 'non-html', body_text: null })).toBe(true);
    expect(needsText({ fetch_status: null, body_text: null })).toBe(true);
  });

  it('is false once the article has text', () => {
    expect(needsText({ fetch_status: 'ok', body_text: 'Some text.' })).toBe(false);
    expect(needsText({ fetch_status: 'pasted', body_text: 'Pasted text.' })).toBe(false);
  });

  it('reads has_text off the duplicate payload', () => {
    expect(needsText({ fetch_status: '503', has_text: 0 })).toBe(true);
    expect(needsText({ fetch_status: 'ok', has_text: 1 })).toBe(false);
  });

  it('does not treat an unknown body as a missing one', () => {
    // A feed row has no body_text field at all; offering to fill in an
    // article that already has text would be worse than not offering.
    expect(needsText({ id: 1, fetch_status: 'ok' })).toBe(false);
    expect(needsText(null)).toBe(false);
  });
});

// The filter bar's controls are React and cannot run in this pool, but the
// mapping from its state to the server's filters is plain JS and is where the
// mistakes would be. §3 "Store"
describe('archiveQueryString', () => {
  const parse = (qs) => Object.fromEntries(new URLSearchParams(qs));

  it('sends only the filters that are on', () => {
    const q = parse(archiveQueryString({ dayStart: 'D' }));
    expect(q).toEqual({ dayStart: 'D', filter: 'all', q: '', limit: String(ARCHIVE_PAGE) });
  });

  it('turns the Starred surface into favorite=1 rather than a client filter', () => {
    expect(parse(archiveQueryString({ dayStart: 'D', surface: 'starred' })).favorite).toBe('1');
    expect(parse(archiveQueryString({ dayStart: 'D', surface: 'archive' })).favorite).toBeUndefined();
  });

  it('carries every §3 filter', () => {
    const q = parse(archiveQueryString({
      dayStart: 'D',
      query: 'scaling',
      filters: {
        ...EMPTY_FILTERS,
        status: 'kept', favorite: true, source: 'arxiv.org',
        tag: 'ml', from: '2026-01-01', to: '2026-02-01'
      }
    }));
    expect(q).toMatchObject({
      q: 'scaling', status: 'kept', favorite: '1', source: 'arxiv.org',
      tag: 'ml', from: '2026-01-01', to: '2026-02-01'
    });
  });

  it('omits the status when it is "all"', () => {
    const q = parse(archiveQueryString({ dayStart: 'D', filters: { ...EMPTY_FILTERS, status: 'all' } }));
    expect(q.status).toBeUndefined();
  });

  it('only sends an offset once there is a page behind it', () => {
    expect(parse(archiveQueryString({ dayStart: 'D', offset: 0 })).offset).toBeUndefined();
    expect(parse(archiveQueryString({ dayStart: 'D', offset: 50 })).offset).toBe('50');
  });
});

describe('activeFilters', () => {
  it('lists what the archive is filtered by, one clearable entry each', () => {
    const labels = activeFilters({ ...EMPTY_FILTERS, status: 'lapsed', tag: 'ml', source: 'x.example' })
      .map((f) => f.label);
    expect(labels).toEqual(['lapsed', 'x.example', '#ml']);
  });

  it('says nothing when nothing is filtered', () => {
    expect(activeFilters(EMPTY_FILTERS)).toEqual([]);
  });

  it('does not offer to clear the favorite filter on the Starred surface', () => {
    const f = { ...EMPTY_FILTERS, favorite: true };
    expect(activeFilters(f, 'archive').map((x) => x.key)).toEqual(['favorite']);
    expect(activeFilters(f, 'starred')).toEqual([]);
  });
});

// V1-23: which empty message a surface shows. Pure decision logic so it can
// be tested without jsdom -- the components just render whatever comes back.
describe('pendingEmptyState', () => {
  it('says nothing is pending at all when the unfiltered total is zero', () => {
    expect(pendingEmptyState({ filter: 'all', pendingTotal: 0 })).toEqual({
      title: 'Pending is empty.',
      note: 'Nothing is waiting on a decision. What you add yourself starts on Today; anything found for you waits here.',
    });
  });

  it('is not fooled by an "opened" or "unopened" filter into saying nothing is pending', () => {
    // pendingTotal is unfiltered, so a nonzero total plus an empty filtered
    // list means the filter is the reason, not an actually-empty Pending.
    expect(pendingEmptyState({ filter: 'opened', pendingTotal: 0 }).title).toBe('Pending is empty.');
  });

  it('names the "Opened" filter when nothing pending has been opened yet', () => {
    expect(pendingEmptyState({ filter: 'opened', pendingTotal: 3 })).toEqual({
      title: 'Nothing opened yet.',
      note: 'Everything pending is still unopened. Try "Never opened", or clear the filter.',
    });
  });

  it('names the "Never opened" filter when everything pending has been opened', () => {
    expect(pendingEmptyState({ filter: 'unopened', pendingTotal: 3 })).toEqual({
      title: 'Nothing left unopened.',
      note: 'Everything pending has been opened at least once. Try "Opened", or clear the filter.',
    });
  });

  it('falls back to a plain message for an unrecognized filter with rows unaccounted for', () => {
    expect(pendingEmptyState({ filter: 'all', pendingTotal: 3 })).toEqual({
      title: 'Nothing here.',
      note: 'Nothing matches this filter.',
    });
  });
});

describe('archiveEmptyState', () => {
  it('returns null when there is nothing to explain', () => {
    expect(archiveEmptyState({ surface: 'archive', filters: EMPTY_FILTERS, query: '', archiveTotal: 5 })).toBeNull();
  });

  it('says the archive is empty when nothing is filtered, searched, or archived', () => {
    expect(archiveEmptyState({ surface: 'archive', filters: EMPTY_FILTERS, query: '', archiveTotal: 0 })).toEqual({
      title: 'Archive is empty.',
      note: 'Kept, dismissed and lapsed articles collect here. Nothing has happened yet.',
    });
  });

  it('says nothing is starred yet on the Starred surface specifically', () => {
    expect(archiveEmptyState({ surface: 'starred', filters: EMPTY_FILTERS, query: '', archiveTotal: 0 })).toEqual({
      title: 'Nothing starred yet.',
      note: 'Star an article while reading it and it will show up here.',
    });
  });

  it('blames the search when a query alone finds nothing', () => {
    const result = archiveEmptyState({ surface: 'archive', filters: EMPTY_FILTERS, query: '  quasar  ', archiveTotal: 0 });
    expect(result.title).toBe('No matches.');
    expect(result.note).toContain('"quasar"');
    expect(result.note).toContain('Clear the search');
  });

  it('blames the filters when they alone find nothing', () => {
    const filters = { ...EMPTY_FILTERS, status: 'lapsed' };
    expect(archiveEmptyState({ surface: 'archive', filters, query: '', archiveTotal: 0 })).toEqual({
      title: 'Nothing matches these filters.',
      note: 'Clear or widen the filters to see more.',
    });
  });

  it('names both the search and the filters when they are combined', () => {
    const filters = { ...EMPTY_FILTERS, tag: 'ml' };
    const result = archiveEmptyState({ surface: 'archive', filters, query: 'quasar', archiveTotal: 0 });
    expect(result.title).toBe('No matches.');
    expect(result.note).toContain('"quasar"');
    expect(result.note).toContain('filters');
  });

  it('treats the Starred favorite filter as the surface, not an active filter, when nothing else narrows it', () => {
    // On Starred, `favorite: true` is implicit and activeFilters() excludes it,
    // so a bare Starred surface with zero rows is "nothing starred yet", not
    // "nothing matches these filters".
    const filters = { ...EMPTY_FILTERS, favorite: true };
    expect(archiveEmptyState({ surface: 'starred', filters, query: '', archiveTotal: 0 }).title).toBe('Nothing starred yet.');
  });

  it('still reports a filter-driven empty state on Starred when a real filter is active', () => {
    const filters = { ...EMPTY_FILTERS, favorite: true, source: 'arxiv.org' };
    expect(archiveEmptyState({ surface: 'starred', filters, query: '', archiveTotal: 0 }).title).toBe('Nothing matches these filters.');
  });
});
