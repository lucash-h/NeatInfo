// The pure half of extraction. Summaries in v1 are meta descriptions falling
// back to the opening ~40 words -- no LLM call. §3 "Show"
import { describe, expect, it } from 'vitest';
import { countWords, summarizeText } from '../worker/extract.js';

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('ignores runs of whitespace and newlines', () => {
    expect(countWords('one   two\n\nthree\t four ')).toBe(4);
  });

  it('returns 0 for empty or missing text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });
});

describe('summarizeText', () => {
  it('treats the first line as a title and summarizes what follows', () => {
    const summary = summarizeText('A Headline\nThe body starts here and carries on.');
    expect(summary).toBe('The body starts here and carries on.');
    expect(summary).not.toContain('A Headline');
  });

  it('caps the summary at 40 words and marks the truncation', () => {
    const body = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const summary = summarizeText('Title\n' + body);
    expect(summary.replace('…', '').trim().split(/\s+/)).toHaveLength(40);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('does not add an ellipsis when the text is shorter than the cap', () => {
    expect(summarizeText('Title\nshort body')).toBe('short body');
  });

  it('falls back to the whole text when there is only one line', () => {
    expect(summarizeText('a single line with no break')).toBe('a single line with no break');
  });

  it('returns an empty string for whitespace only', () => {
    expect(summarizeText('   \n  ')).toBe('');
  });
});
