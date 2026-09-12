// §6: Tier 1 behind a `speak / pause / stop` interface. The tests drive a fake
// engine, which is the same seam Tier 2 (R2 audio + Media Session) will use --
// if this file can swap the engine, so can §6's upgrade.
import { describe, expect, it } from 'vitest';
import { chunkText, createPlayer, webSpeechEngine, stallTimeout, CHUNK_CHARS, HEARTBEAT_MS } from '../src/tts.js';

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

// V1-31. Two failures that both looked like "it just stops".
describe('the Chrome heartbeat', () => {
  function fakeSynth({ speaking = true, paused = false, pending = false } = {}) {
    return {
      speaking, paused, pending,
      resumes: 0, cancels: 0, pauses: 0,
      speak() {},
      pause() { this.pauses += 1; },
      resume() { this.resumes += 1; },
      cancel() { this.cancels += 1; }
    };
  }

  // A controllable clock. It records the delay it was handed, because a fake
  // that discards the delay cannot tell HEARTBEAT_MS from ten minutes -- which
  // is how a heartbeat that restarted on every chunk, and therefore almost
  // never fired, passed four tests.
  function fakeClock() {
    const timers = new Map();
    const delays = [];
    let next = 1;
    // Closure, not `this`: the engine destructures these functions out of the
    // object, so a method relying on its receiver loses it.
    return {
      delays,
      setInterval: (fn, ms) => { delays.push(ms); timers.set(next, fn); return next++; },
      clearInterval: (id) => { timers.delete(id); },
      tick: () => { for (const fn of [...timers.values()]) fn(); },
      get count() { return timers.size; }
    };
  }

  it('resumes on a schedule while speaking, which is what keeps Chrome going', () => {
    const synth = fakeSynth();
    const clock = fakeClock();
    globalThis.SpeechSynthesisUtterance = class { addEventListener() {} };

    const engine = webSpeechEngine(synth, clock);
    engine.speak('some text', {});

    expect(clock.count).toBe(1);
    clock.tick();
    clock.tick();
    expect(synth.resumes).toBe(2);
  });

  it('does not drag a paused article back into playing', () => {
    // Driven through the real sequence -- speak, then pause -- rather than
    // constructed already-paused, because pause intent is tracked in the
    // engine now rather than read back from synth.paused. That flag is
    // unreliable, and the stalled state this heartbeat exists to escape is
    // itself reported as paused by some builds, which would have suppressed
    // the resume in exactly the case that needs it.
    const synth = fakeSynth({ speaking: true });
    const clock = fakeClock();
    globalThis.SpeechSynthesisUtterance = class { addEventListener() {} };

    const engine = webSpeechEngine(synth, clock);
    engine.speak('some text', {});
    engine.pause();
    clock.tick();

    expect(synth.resumes).toBe(0);
    expect(clock.count).toBe(0);
  });

  it('resumes the heartbeat on resume, even while synth.paused still reads true', () => {
    const synth = fakeSynth({ speaking: true, paused: true });
    const clock = fakeClock();
    globalThis.SpeechSynthesisUtterance = class { addEventListener() {} };

    const engine = webSpeechEngine(synth, clock);
    engine.speak('some text', {});
    engine.pause();
    engine.resume();
    clock.tick();

    expect(synth.resumes).toBeGreaterThan(0);
  });

  it('stops the timer on cancel, so nothing pokes a dead synth', () => {
    const synth = fakeSynth();
    const clock = fakeClock();
    globalThis.SpeechSynthesisUtterance = class { addEventListener() {} };

    const engine = webSpeechEngine(synth, clock);
    engine.speak('some text', {});
    expect(clock.count).toBe(1);

    engine.cancel();
    expect(clock.count).toBe(0);
  });

  it('uses the documented interval, not merely some interval', () => {
    const clock = fakeClock();
    globalThis.SpeechSynthesisUtterance = class { addEventListener() {} };

    webSpeechEngine(fakeSynth(), clock).speak('some text', {});

    expect(clock.delays).toEqual([HEARTBEAT_MS]);
  });

  it('survives a chunk boundary, because the limit spans the whole queue', () => {
    // The original bug: `end` tore the timer down and the next speak() built a
    // fresh one, so the interval restarted every chunk and only fired if a
    // single chunk ran longer than HEARTBEAT_MS. The browser's counter mean-
    // while ran on across the queue. The test that used to live here asserted
    // that teardown as correct.
    const synth = fakeSynth({ speaking: true, pending: true });
    const clock = fakeClock();
    const listeners = {};
    globalThis.SpeechSynthesisUtterance = class {
      addEventListener(name, fn) { listeners[name] = fn; }
    };

    const engine = webSpeechEngine(synth, clock);
    engine.speak('chunk one', { onEnd() {}, onError() {} });
    const first = clock.count;

    listeners.end();
    engine.speak('chunk two', { onEnd() {}, onError() {} });

    expect(clock.count).toBe(first);
    expect(clock.delays).toEqual([HEARTBEAT_MS]);
  });

  it('stops once the queue is genuinely exhausted', () => {
    const synth = fakeSynth({ speaking: false, pending: false });
    const clock = fakeClock();
    const listeners = {};
    globalThis.SpeechSynthesisUtterance = class {
      addEventListener(name, fn) { listeners[name] = fn; }
    };

    const engine = webSpeechEngine(synth, clock);
    engine.speak('the last chunk', { onEnd() {}, onError() {} });
    listeners.end();

    expect(clock.count).toBe(0);
  });

  it('stops the timer when the utterance errors', () => {
    const clock = fakeClock();
    const listeners = {};
    globalThis.SpeechSynthesisUtterance = class {
      addEventListener(name, fn) { listeners[name] = fn; }
    };

    const engine = webSpeechEngine(fakeSynth(), clock);
    engine.speak('some text', { onEnd() {}, onError() {} });
    expect(clock.count).toBe(1);
    listeners.error(new Error('nope'));
    expect(clock.count).toBe(0);
  });

  it('stops the timer when the synth falls silent on its own', () => {
    // The self-stop that keeps the synchronous fast path from being the only
    // thing holding the fix up.
    const synth = fakeSynth({ speaking: false, pending: false });
    const clock = fakeClock();
    globalThis.SpeechSynthesisUtterance = class { addEventListener() {} };

    const engine = webSpeechEngine(synth, clock);
    engine.speak('some text', {});
    clock.tick();

    expect(clock.count).toBe(0);
    expect(synth.resumes).toBe(0);
  });
});

describe('the stall watchdog', () => {
  function fakeClock() {
    const timers = new Map();
    const delays = [];
    let next = 1;
    return {
      delays,
      setTimeout: (fn, ms) => { delays.push(ms); timers.set(next, fn); return next++; },
      clearTimeout: (id) => { timers.delete(id); },
      fire: () => { const all = [...timers.values()]; timers.clear(); all.forEach((fn) => fn()); },
      get count() { return timers.size; }
    };
  }

  it('reports an error when the engine goes silent without ending', () => {
    // The exact shape of the 15-second bug: no end, no error, just silence.
    const engine = fakeEngine();
    const clock = fakeClock();
    const player = createPlayer(engine, clock);
    const errors = [];

    player.speak('A sentence long enough to be worth speaking aloud.', {
      onError: (err) => errors.push(err)
    });
    expect(player.status()).toBe('playing');

    clock.fire();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/stopped unexpectedly/i);
    expect(player.status()).toBe('idle');
    expect(engine.cancels).toBeGreaterThan(0);
  });

  it('does not fire while the engine is making progress', () => {
    const engine = fakeEngine();
    const clock = fakeClock();
    const player = createPlayer(engine, clock);
    const errors = [];

    player.speak('A sentence long enough to be worth speaking aloud.', {
      onError: (err) => errors.push(err)
    });
    // A boundary is proof of life and pushes the deadline out.
    engine.boundary(5);
    engine.boundary(10);
    engine.finish();

    expect(errors).toHaveLength(0);
  });

  it('does not accuse a paused article of stalling', () => {
    const engine = fakeEngine();
    const clock = fakeClock();
    const player = createPlayer(engine, clock);
    const errors = [];

    player.speak('A sentence long enough to be worth speaking aloud.', {
      onError: (err) => errors.push(err)
    });
    player.pause();

    expect(clock.count).toBe(0);
    clock.fire();
    expect(errors).toHaveLength(0);
  });

  it('is disarmed once the whole article finishes', () => {
    const engine = fakeEngine();
    const clock = fakeClock();
    const player = createPlayer(engine, clock);
    const errors = [];

    player.speak('One. Two. Three.', { onError: (err) => errors.push(err) });
    engine.playAll();

    expect(player.status()).toBe('done');
    expect(clock.count).toBe(0);
  });

  it('is armed with stallTimeout for the chunk actually being spoken', () => {
    // Without this, armWatchdog could pass 0 -- firing instantly on every
    // chunk and breaking playback outright -- and every other test in this
    // block would still pass, because none of them advances a clock.
    const engine = fakeEngine();
    const clock = fakeClock();
    const player = createPlayer(engine, clock);

    const text = 'A sentence long enough to be worth speaking aloud.';
    player.speak(text, {});

    const firstChunk = chunkText(text)[0];
    expect(clock.delays[0]).toBe(stallTimeout(firstChunk));
    expect(clock.delays[0]).toBeGreaterThan(0);
  });

  it('scales its patience with the length of the chunk', () => {
    expect(stallTimeout('short')).toBe(12000);                // the floor
    const long = stallTimeout('x'.repeat(600));
    expect(long).toBeGreaterThan(12000);
  });
});
