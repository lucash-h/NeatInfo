// §6: "Build Tier 1 with the player behind a small interface so Tier 2 drops
// in without touching the UI."
//
// That interface is `speak / pause / resume / stop`, and everything the Web
// Speech API knows lives behind `webSpeechEngine`. Tier 2 (server-side audio
// in R2, played through an <audio> element with the Media Session API) is a
// second engine object with the same four methods plus `available`, handed to
// `setEngine()`. No component changes.

// Chrome stops speaking after roughly fifteen seconds of a single utterance,
// so a long article is spoken as a queue of short ones. ~220 characters is
// about eight seconds of speech at the default rate.
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

export function webSpeechEngine(synth = globalThis.speechSynthesis) {
  const available = Boolean(synth) && typeof globalThis.SpeechSynthesisUtterance === 'function';

  return {
    available,
    speak(text, { onEnd, onError, onBoundary } = {}) {
      if (!available) return onError?.(new Error('This browser has no speech synthesis'));
      const utterance = new globalThis.SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      if (onBoundary) utterance.addEventListener('boundary', (e) => onBoundary(e.charIndex || 0));
      utterance.addEventListener('end', () => onEnd?.());
      utterance.addEventListener('error', (e) => onError?.(e));
      synth.speak(utterance);
    },
    pause() { if (available) synth.pause(); },
    resume() { if (available) synth.resume(); },
    cancel() { if (available) synth.cancel(); }
  };
}

// ------------------------------------------------------------- the player

export function createPlayer(engine) {
  let chunks = [];
  let index = 0;
  let spoken = 0;      // characters completed before the current chunk
  let total = 1;
  let status = 'idle'; // idle | playing | paused | done
  let handlers = {};

  const report = (chars) => handlers.onProgress?.(Math.min(1, chars / total));

  function speakNext() {
    if (index >= chunks.length) {
      status = 'done';
      report(total);
      handlers.onEnd?.();
      return;
    }
    const chunk = chunks[index];
    engine.speak(chunk, {
      onBoundary: (charIndex) => {
        if (status === 'playing') report(spoken + charIndex);
      },
      onEnd: () => {
        // A cancelled utterance also fires `end` in some browsers; ignore it
        // unless we are still meant to be playing.
        if (status !== 'playing') return;
        spoken += chunk.length + 1;
        index += 1;
        speakNext();
      },
      onError: (err) => {
        status = 'idle';
        handlers.onError?.(err);
      }
    });
  }

  function stop() {
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
      engine.pause();
      status = 'paused';
      return true;
    },
    resume() {
      if (status !== 'paused') return false;
      engine.resume();
      status = 'playing';
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
