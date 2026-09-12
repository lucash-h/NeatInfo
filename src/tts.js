// §6: "Build Tier 1 with the player behind a small interface so Tier 2 drops
// in without touching the UI."
//
// That interface is `speak / pause / resume / stop`, and everything the Web
// Speech API knows lives behind `webSpeechEngine`. Tier 2 (server-side audio
// in R2, played through an <audio> element with the Media Session API) is a
// second engine object with the same four methods plus `available`, handed to
// `setEngine()`. No component changes.

// Chrome stops speaking after roughly fifteen seconds -- of *total speaking
// time*, not of a single utterance, which is the correction that matters. This
// file used to say the latter, and chunked to ~8 seconds on that basis; a
// queue of twenty short utterances hits the same wall as one long one, which
// is why articles died after a couple of paragraphs. The heartbeat in
// webSpeechEngine is what actually fixes it. V1-31
//
// The chunking stays: shorter utterances still give smoother progress
// reporting and a cleaner cancel, and ~220 characters is about eight seconds
// of speech at the default rate.
export const CHUNK_CHARS = 220;

// Split on sentence ends first, because a chunk boundary mid-sentence is
// audible; fall back to word boundaries, then to a hard cut for text that has
// neither (a URL, a run-on paragraph).
export function chunkText(text, max = CHUNK_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
  const chunks = [];
  let buf = '';

  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > max) {
      flush();
      let rest = sentence.trim();
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max);
        const at = cut > max * 0.5 ? cut : max;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      buf = rest;
      continue;
    }
    if ((buf + sentence).length > max) flush();
    buf += sentence;
  }
  flush();
  return chunks;
}

// --------------------------------------------------------- Tier 1 engine

// Chromium issues 41294170 and 41346274: speech stops after ~15 seconds and
// fires nothing -- no `end`, no `error`. Calling resume() on a timer before
// that deadline keeps it going. It is inelegant and it is the documented
// workaround.
//
// It lives in the engine rather than the player because it is a Web Speech
// defect, and §6's Tier 2 (R2 audio through an <audio> element) must not
// inherit a workaround for a bug it does not have.
export const HEARTBEAT_MS = 10000;

export function webSpeechEngine(synth = globalThis.speechSynthesis, { setInterval: si, clearInterval: ci } = {}) {
  const available = Boolean(synth) && typeof globalThis.SpeechSynthesisUtterance === 'function';
  const startTimer = si || globalThis.setInterval;
  const stopTimer = ci || globalThis.clearInterval;

  let beat = null;

  // Every exit from speaking goes through here. A timer left running would
  // poke a dead synth forever, and on some browsers resume() on an idle synth
  // restarts the last utterance.
  const stopHeartbeat = () => {
    if (beat === null) return;
    stopTimer(beat);
    beat = null;
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    beat = startTimer(() => {
      // `speaking` stays true while paused, so an article the reader paused is
      // not dragged back into playing by the heartbeat.
      if (synth.speaking && !synth.paused) synth.resume();
    }, HEARTBEAT_MS);
  };

  return {
    available,
    speak(text, { onEnd, onError, onBoundary } = {}) {
      if (!available) return onError?.(new Error('This browser has no speech synthesis'));
      const utterance = new globalThis.SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      if (onBoundary) utterance.addEventListener('boundary', (e) => onBoundary(e.charIndex || 0));
      utterance.addEventListener('end', () => {
        stopHeartbeat();
        onEnd?.();
      });
      utterance.addEventListener('error', (e) => {
        stopHeartbeat();
        onError?.(e);
      });
      synth.speak(utterance);
      startHeartbeat();
    },
    pause() { if (available) synth.pause(); },
    resume() { if (available) synth.resume(); },
    cancel() {
      stopHeartbeat();
      if (available) synth.cancel();
    }
  };
}

// ------------------------------------------------------------- the player

// Speech runs at roughly 15 characters a second at rate 1. The watchdog waits
// several times a chunk's expected duration before giving up, so a slow voice
// or a long word is never mistaken for a stall.
const CHARS_PER_SECOND = 15;
const STALL_GRACE = 4;
const STALL_FLOOR_MS = 8000;

export function stallTimeout(chunk, { charsPerSecond = CHARS_PER_SECOND, grace = STALL_GRACE } = {}) {
  const expected = (String(chunk || '').length / charsPerSecond) * 1000;
  return Math.max(STALL_FLOOR_MS, Math.round(expected * grace));
}

export function createPlayer(engine, { setTimeout: st, clearTimeout: ct } = {}) {
  const startTimer = st || globalThis.setTimeout;
  const stopTimer = ct || globalThis.clearTimeout;
  let watchdog = null;
  let chunks = [];
  let index = 0;
  let spoken = 0;      // characters completed before the current chunk
  let total = 1;
  let status = 'idle'; // idle | playing | paused | done
  let handlers = {};

  const report = (chars) => handlers.onProgress?.(Math.min(1, chars / total));

  const clearWatchdog = () => {
    if (watchdog === null) return;
    stopTimer(watchdog);
    watchdog = null;
  };

  // The real lesson of the 15-second bug was not the 15 seconds: it was that
  // the engine could stop dead -- no `end`, no `error` -- and the player had
  // no way to notice. It sat in `playing` forever and the reader just saw
  // silence. Any engine can do that, including Tier 2 over a flaky network,
  // so the check belongs here. V1-31
  const armWatchdog = (chunk) => {
    clearWatchdog();
    watchdog = startTimer(() => {
      if (status !== 'playing') return;
      status = 'idle';
      engine.cancel();
      handlers.onError?.(new Error('Speech stopped unexpectedly. Press play to continue.'));
    }, stallTimeout(chunk));
  };

  function speakNext() {
    if (index >= chunks.length) {
      clearWatchdog();
      status = 'done';
      report(total);
      handlers.onEnd?.();
      return;
    }
    const chunk = chunks[index];
    armWatchdog(chunk);
    engine.speak(chunk, {
      onBoundary: (charIndex) => {
        if (status !== 'playing') return;
        // Progress is proof of life: each boundary pushes the deadline out, so
        // a long chunk that is genuinely being spoken never trips the alarm.
        armWatchdog(chunk);
        report(spoken + charIndex);
      },
      onEnd: () => {
        // A cancelled utterance also fires `end` in some browsers; ignore it
        // unless we are still meant to be playing.
        if (status !== 'playing') return;
        clearWatchdog();
        spoken += chunk.length + 1;
        index += 1;
        speakNext();
      },
      onError: (err) => {
        clearWatchdog();
        status = 'idle';
        handlers.onError?.(err);
      }
    });
  }

  function stop() {
    clearWatchdog();
    const wasSpeaking = status === 'playing' || status === 'paused';
    chunks = [];
    index = 0;
    spoken = 0;
    status = 'idle';
    handlers = {};
    engine.cancel();
    return wasSpeaking;
  }

  return {
    get supported() { return engine.available; },
    status: () => status,
    speak(text, opts = {}) {
      stop();
      const next = chunkText(text);
      if (!next.length) return false;
      handlers = opts;
      chunks = next;
      total = next.join(' ').length || 1;
      status = 'playing';
      speakNext();
      return true;
    },
    pause() {
      if (status !== 'playing') return false;
      // A paused article produces no boundaries, which is exactly what a stall
      // looks like. Disarm rather than accuse.
      clearWatchdog();
      engine.pause();
      status = 'paused';
      return true;
    },
    resume() {
      if (status !== 'paused') return false;
      engine.resume();
      status = 'playing';
      armWatchdog(chunks[index] || '');
      return true;
    },
    stop
  };
}

// ----------------------------------------------------------- the singleton

// One player for the whole app: the reader is a single surface, and two
// articles talking at once is the bug this file exists to prevent.
let player = null;

export function getPlayer() {
  if (!player) player = createPlayer(webSpeechEngine());
  return player;
}

// The Tier 2 swap point. §6
export function setEngine(engine) {
  if (player) player.stop();
  player = createPlayer(engine);
  return player;
}
