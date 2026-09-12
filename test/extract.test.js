// The pure half of extraction. Summaries in v1 are meta descriptions falling
// back to the opening ~40 words -- no LLM call. §3 "Show"
import { describe, expect, it } from 'vitest';
import { countWords, decodeEntities, summarizeText } from '../worker/extract.js';

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

// V1-30. HTMLRewriter returns attribute values undecoded, so everything read
// from a <meta content="..."> arrived escaped while body text did not. These
// pin the decoder, and in particular the ordering: ampersand has to be last.
describe('decodeEntities', () => {
  it('decodes the named entities that actually occur in page metadata', () => {
    expect(decodeEntities('&quot;best software&quot; pages')).toBe('"best software" pages');
    expect(decodeEntities('a &lt; b &gt; c')).toBe('a < b > c');
    expect(decodeEntities('it&apos;s here')).toBe("it's here");
  });

  it('decodes decimal and hex numeric entities', () => {
    expect(decodeEntities('Ed Zitron&#39;s record')).toBe("Ed Zitron's record");
    expect(decodeEntities('Meta&#039;s agent')).toBe("Meta's agent");
    expect(decodeEntities('caf&#xe9; &#x27;s')).toBe("café 's");
  });

  it('decodes a bare ampersand entity', () => {
    expect(decodeEntities('features &amp; capabilities')).toBe('features & capabilities');
  });

  it('does not double-decode: &amp;#39; is a literal, not an apostrophe', () => {
    // The reason &amp; is handled last. A page that correctly escaped the text
    // "&#39;" must come back as "&#39;", not as "'".
    expect(decodeEntities('write &amp;#39; to escape')).toBe("write &#39; to escape");
    expect(decodeEntities('&amp;quot;')).toBe('&quot;');
  });

  it('leaves unknown entities and bare ampersands alone', () => {
    expect(decodeEntities('Tom &amp; Jerry &mdash; a pair')).toBe('Tom & Jerry &mdash; a pair');
    expect(decodeEntities('R&D spending')).toBe('R&D spending');
    expect(decodeEntities('50% & rising')).toBe('50% & rising');
  });

  it('refuses nonsense code points rather than throwing or inventing text', () => {
    expect(decodeEntities('&#0;')).toBe('&#0;');
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');   // above U+10FFFF
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');       // lone surrogate
  });

  it('passes through anything with no entity in it, including non-strings', () => {
    expect(decodeEntities('a plain title')).toBe('a plain title');
    expect(decodeEntities('')).toBe('');
    expect(decodeEntities(null)).toBe(null);
    expect(decodeEntities(undefined)).toBe(undefined);
  });

  it('handles several entities of different kinds in one value', () => {
    expect(decodeEntities('Three sites made 215,128 &quot;best&quot; pages &amp; Meta&#039;s agent'))
      .toBe('Three sites made 215,128 "best" pages & Meta\'s agent');
  });
});
