// Duplicate detection is only as good as normalizeUrl. §3 "Pull"
import { describe, expect, it } from 'vitest';
import { normalizeUrl, sourceFromUrl } from '../worker/url.js';

describe('normalizeUrl', () => {
  it('strips utm_* tracking parameters', () => {
    expect(normalizeUrl('https://example.com/post?utm_source=twitter&utm_medium=social'))
      .toBe('https://example.com/post');
  });

  it('strips ref, fbclid, gclid and friends but keeps real parameters', () => {
    expect(normalizeUrl('https://example.com/post?ref=hn&fbclid=abc&gclid=def&id=7'))
      .toBe('https://example.com/post?id=7');
  });

  it('removes a leading www.', () => {
    expect(normalizeUrl('https://www.example.com/post')).toBe('https://example.com/post');
  });

  it('lowercases the hostname but leaves the path alone', () => {
    expect(normalizeUrl('https://Example.COM/Post/Title')).toBe('https://example.com/Post/Title');
  });

  it('drops a trailing slash, keeping the root path as /', () => {
    expect(normalizeUrl('https://example.com/post/')).toBe('https://example.com/post');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('sorts query parameters so ordering is not a difference', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1')).toBe('https://example.com/p?a=1&b=2');
  });

  it('upgrades http to https', () => {
    expect(normalizeUrl('http://example.com/post')).toBe('https://example.com/post');
  });

  it('discards the fragment', () => {
    expect(normalizeUrl('https://example.com/post#section-3')).toBe('https://example.com/post');
  });

  it('rejects non-http(s) schemes', () => {
    expect(normalizeUrl('mailto:someone@example.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://example.com/file')).toBeNull();
  });

  it('rejects garbage input rather than throwing', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(normalizeUrl('  https://example.com/post  ')).toBe('https://example.com/post');
  });

  // The two pairs the unique index actually has to catch.
  it('normalizes a shared link and a typed link to the same key', () => {
    const shared = normalizeUrl('https://www.example.com/post/?utm_source=newsletter&utm_campaign=x#top');
    const typed = normalizeUrl('http://example.com/post');
    expect(shared).toBe(typed);
  });

  it('normalizes parameter-reordered links to the same key', () => {
    expect(normalizeUrl('https://example.com/p?a=1&b=2'))
      .toBe(normalizeUrl('https://www.example.com/p/?b=2&a=1&ref=hn'));
  });

  it('keeps genuinely different URLs different', () => {
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/b'));
    expect(normalizeUrl('https://example.com/p?id=1')).not.toBe(normalizeUrl('https://example.com/p?id=2'));
  });
});

describe('sourceFromUrl', () => {
  it('returns the bare hostname', () => {
    expect(sourceFromUrl('https://www.nytimes.com/2026/01/01/a.html')).toBe('nytimes.com');
    expect(sourceFromUrl('https://arxiv.org/abs/2401.00001')).toBe('arxiv.org');
  });

  it('falls back to "unknown" rather than throwing', () => {
    expect(sourceFromUrl('not a url')).toBe('unknown');
  });
});
