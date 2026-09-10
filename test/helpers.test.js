// Card metadata and the lapse countdown the Pending surface shows. §2.4, §3
import { describe, expect, it } from 'vitest';
import { ageLabel, daysSince, lapseInfo, metaLine, needsText, readMinutes } from '../src/helpers.js';
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
