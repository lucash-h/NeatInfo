// §6: Tier 1 behind a `speak / pause / stop` interface. The tests drive a fake
// engine, which is the same seam Tier 2 (R2 audio + Media Session) will use --
// if this file can swap the engine, so can §6's upgrade.
import { describe, expect, it } from 'vitest';
import { chunkText, createPlayer, webSpeechEngine, CHUNK_CHARS } from '../src/tts.js';

// Stands in for speechSynthesis: nothing happens until the test says an
// utterance finished, which is how a real browser behaves.
function fakeEngine({ available = true } = {}) {
  const engine = {
    available,
    spoken: [],
    cancels: 0,
    pauses: 0,
    resumes: 0,
    current: null,
    speak(text, handlers) {
      engine.spoken.push(text);
      engine.current = handlers;
    },
    pause() { engine.pauses += 1; },
    resume() { engine.resumes += 1; },
    cancel() { engine.cancels += 1; engine.current = null; },
    // Test-only: finish the utterance in flight.
    finish() {
      const h = engine.current;
      engine.current = null;
      h?.onEnd?.();
    },
    boundary(charIndex) { engine.current?.onBoundary?.(charIndex); },
    error(err) { engine.current?.onError?.(err); },
    playAll(limit = 500) {
      let n = 0;
      while (engine.current && n < limit) { engine.finish(); n += 1; }
      return n;
    }
  };
  return engine;
}

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
  });

  it('keeps short text in one chunk', () => {
    expect(chunkText('One short sentence.')).toEqual(['One short sentence.']);
  });

  it('breaks on sentence ends rather than mid-sentence', () => {
    const text = ('This is a sentence of a reasonable length. ').repeat(6);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c.endsWith('.')).toBe(true);
    }
  });

  it('hard-splits text that has no sentence ends at all', () => {
    const chunks = chunkText('word '.repeat(400));
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
  });

  it('loses no words', () => {
    const text = 'Alpha beta gamma. Delta epsilon zeta! Eta theta? Iota. '.repeat(20);
    const words = (s) => s.split(/\s+/).filter(Boolean).length;
    expect(chunkText(text).reduce((n, c) => n + words(c), 0)).toBe(words(text));
  });
});

describe('the player', () => {
  it('speaks a long article to the end, one chunk at a time', () => {
    // ~5,000 words, the case Chrome's fifteen-second cutoff breaks when the
    // whole article is a single utterance.
    const article = 'Scaling laws describe a smooth relationship between compute and loss. '.repeat(450);
    const engine = fakeEngine();
    const player = createPlayer(engine);

    let ended = false;
    let progress = 0;
    player.speak(article, { onEnd: () => { ended = true; }, onProgress: (p) => { progress = p; } });

    expect(engine.spoken).toHaveLength(1);   // only the first chunk is queued
    expect(player.status()).toBe('playing');

    engine.playAll();

    expect(ended).toBe(true);
    expect(progress).toBe(1);
    expect(player.status()).toBe('done');
    expect(engine.spoken.length).toBeGreaterThan(100);
  });

  it('reports progress from utterance boundaries', () => {
    const engine = fakeEngine();
    const player = createPlayer(engine);
    const seen = [];
    player.speak('Alpha beta gamma. '.repeat(40), { onProgress: (p) => seen.push(p) });

    engine.boundary(10);
    expect(seen.at(-1)).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeLessThan(1);
  });

  it('pauses and resumes without restarting the article', () => {
    const engine = fakeEngine();
    const player = createPlayer(engine);
    player.speak('Alpha beta gamma. '.repeat(40));
    engine.finish();
    const spokenSoFar = engine.spoken.length;

    expect(player.pause()).toBe(true);
    expect(player.status()).toBe('paused');
    expect(engine.pauses).toBe(1);
    expect(player.pause()).toBe(false);       // already paused

    expect(player.resume()).toBe(true);
    expect(player.status()).toBe('playing');
    expect(engine.resumes).toBe(1);
    expect(engine.spoken).toHaveLength(spokenSoFar);
  });

  it('stops: cancels the engine and speaks nothing further', () => {
    const engine = fakeEngine();
    const player = createPlayer(engine);
    player.speak('Alpha beta gamma delta. '.repeat(40));
    const spokenSoFar = engine.spoken.length;

    expect(player.stop()).toBe(true);
    // Two cancels: speak() resets the engine before it starts, stop() again.
    expect(engine.cancels).toBe(2);
    expect(player.status()).toBe('idle');

    // A late `end` from the cancelled utterance must not restart the queue.
    engine.current = { onEnd: () => {} };
    engine.finish();
    expect(engine.spoken).toHaveLength(spokenSoFar);
  });

  it('never lets two articles talk at once', () => {
    const engine = fakeEngine();
    const player = createPlayer(engine);
    player.speak('The first article. '.repeat(20));
    player.speak('The second article. '.repeat(20));
    expect(engine.cancels).toBeGreaterThanOrEqual(1);
    expect(engine.spoken.at(-1)).toContain('second');
    engine.playAll();
    expect(engine.spoken.filter((s) => s.includes('first'))).toHaveLength(1);
  });

  it('refuses to start on empty text and reports engine errors', () => {
    const engine = fakeEngine();
    const player = createPlayer(engine);
    expect(player.speak('   ')).toBe(false);
    expect(player.status()).toBe('idle');

    let failure = null;
    player.speak('Something to say.', { onError: (e) => { failure = e; } });
    engine.error(new Error('voice unavailable'));
    expect(failure.message).toBe('voice unavailable');
    expect(player.status()).toBe('idle');
  });

  it('exposes whether the engine is usable at all', () => {
    expect(createPlayer(fakeEngine()).supported).toBe(true);
    expect(createPlayer(fakeEngine({ available: false })).supported).toBe(false);
  });
});

describe('the Web Speech engine', () => {
  it('reports itself unavailable where speechSynthesis is missing', () => {
    // workerd has no speechSynthesis, which is exactly the "browser without
    // TTS" case the player must survive.
    const engine = webSpeechEngine(undefined);
    expect(engine.available).toBe(false);
    let failure = null;
    engine.speak('anything', { onError: (e) => { failure = e; } });
    expect(failure).toBeInstanceOf(Error);
    expect(() => { engine.pause(); engine.resume(); engine.cancel(); }).not.toThrow();
  });
});
