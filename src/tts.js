// §6: "Build Tier 1 with the player behind a small interface so Tier 2 drops
// in without touching the UI."
//
// That interface is `speak / pause / resume / stop`, and everything the Web
// Speech API knows lives behind `webSpeechEngine`. Tier 2 is a second engine
// object with the same methods plus `available`, handed to `setEngine()`.
//
// It generates audio on demand and stores none of it -- the original plan was
// to cache it in R2, which measurement killed: melotts returns 44.1kHz WAV at
// 88 KB a second, and §9.7 says not to hoard what is expensive and
// reproducible. Comments elsewhere describing Tier 2 as "R2 audio" predate
// that and are wrong; there is no bucket involved.

// Chrome stops speaking after roughly fifteen seconds. Whether that limit is
// per-utterance or across the whole speaking session is not settled here --
// both models explain the reported symptom, and this file used to assert the
// second confidently. The heartbeat in webSpeechEngine resets the counter
// under either, which is what makes playback correct without having to know.
//
// Chunk size is therefore an audio-quality knob, not a safety mechanism, with
// one hedge: at 220 characters an ordinary paragraph produced a 14.7s chunk,
// sitting exactly on the line if the limit turns out to be per-utterance. 150
// gives a worst case near 10s with no more mid-sentence cuts than 180, while
// 120 would hard-cut typical sentences (100-140 characters) for no real gain
// -- a slow voice puts any character count back on the line, because
// characters are a proxy for seconds and not a constant one.
//
// ~15 characters a second at rate 1 is the realistic figure. An earlier
// comment here said 220 characters was "about eight seconds", which is 27.5
// chars/s and disagreed with CHARS_PER_SECOND further down this same file.
export const CHUNK_CHARS = 150;

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
// defect, and §6's Tier 2 (server-generated audio through an <audio> element)
// must not
// inherit a workaround for a bug it does not have.
export const HEARTBEAT_MS = 10000;

export function webSpeechEngine(synth = globalThis.speechSynthesis, { setInterval: si, clearInterval: ci } = {}) {
  const available = Boolean(synth) && typeof globalThis.SpeechSynthesisUtterance === 'function';
  const startTimer = si || globalThis.setInterval;
  const stopTimer = ci || globalThis.clearInterval;

  let beat = null;
  // Whether the *reader* paused, tracked here rather than read back from
  // `synth.paused`. Chrome's flag is unreliable, and the stalled state this
  // heartbeat exists to escape is itself reported as paused by some builds --
  // so trusting it would suppress the resume in exactly the case that needs
  // it, while also being the only thing standing between a paused article and
  // being un-paused by a timer. One unreliable flag cannot serve both needs.
  let userPaused = false;

  const stopHeartbeat = () => {
    if (beat === null) return;
    stopTimer(beat);
    beat = null;
  };

  // The interval spans the whole speaking session, not one utterance. The
  // first version restarted it on every chunk, which made it a defence against
  // a *per-utterance* limit -- the very model this file rejects. Since a chunk
  // is at most ~15s and the interval is 10s, it fired at most once per chunk
  // and usually never, while Chrome's counter ran on across the queue.
  const startHeartbeat = () => {
    if (beat !== null) return;
    beat = startTimer(() => {
      // `pending` matters because the player calls speakNext() synchronously
      // from `end`: there is a tick where nothing is speaking yet but the next
      // utterance is already queued.
      if (!synth.speaking && !synth.pending) {
        stopHeartbeat();
        return;
      }
      if (!userPaused) synth.resume();
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
        // The player queues the next chunk synchronously from here, so by the
        // time onEnd returns the synth is speaking or pending again and the
        // heartbeat rightly survives. Only a genuinely exhausted queue stops
        // it. A fast path, not the teardown: the tick stops itself on silence
        // too, so if that synchronous assumption ever changes this degrades to
        // a late stop rather than back to a heartbeat that never fires.
        onEnd?.();
        if (!synth.speaking && !synth.pending) stopHeartbeat();
      });
      utterance.addEventListener('error', (e) => {
        stopHeartbeat();
        onError?.(e);
      });
      synth.speak(utterance);
      startHeartbeat();
    },
    pause() {
      userPaused = true;
      // Speaking time does not accrue while paused, so the heartbeat has
      // nothing to defend and is stopped rather than left ticking.
      stopHeartbeat();
      if (available) synth.pause();
    },
    resume() {
      userPaused = false;
      if (available) synth.resume();
      startHeartbeat();
    },
    cancel() {
      userPaused = false;
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
// Chrome's remote voices synthesize server-side and can take 1-3s to utter a
// first sound, which a short final chunk would otherwise run up against.
const STALL_FLOOR_MS = 12000;

export function stallTimeout(chunk, { charsPerSecond = CHARS_PER_SECOND, grace = STALL_GRACE } = {}) {
  const chars = typeof chunk === 'string' ? chunk.length : (Number(chunk?.chars) || 0);
  const expected = (chars / charsPerSecond) * 1000;
  return Math.max(STALL_FLOOR_MS, Math.round(expected * grace));
}

// A unit is either a string (Tier 1) or a descriptor carrying its own size
// (Tier 2). Progress is reported against real text length either way, so the
// bar does not jump when a short final segment finishes.
function unitSize(unit) {
  if (typeof unit === 'string') return unit.length;
  return Number(unit?.chars) || 1;
}

export function createPlayer(initialEngine, { setTimeout: st, clearTimeout: ct } = {}) {
  let engine = initialEngine;
  const startTimer = st || globalThis.setTimeout;
  const stopTimer = ct || globalThis.clearTimeout;
  let watchdog = null;
  // Bumped by every stop(), so work started before a stop can tell that it is
  // no longer wanted.
  let generation = 0;
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
      // stop() nulls handlers before cancelling so a cancel-induced `error`
      // cannot re-enter and report twice; the watchdog has to do the same.
      // speakNext's onError has no status guard, and a Tier 2 engine whose
      // error object carries a .message would toast a second, confusing
      // message over this one.
      const notify = handlers.onError;
      handlers = {};
      status = 'idle';
      engine.cancel();
      // "start over" because that is what pressing play does: status is idle,
      // so TtsPlayer falls through to speak(), whose first act is stop().
      // Resuming from the stalled chunk is possible -- chunks and index are
      // still here -- but is not built, and a message promising what the code
      // does not do is the exact failure this task exists to correct.
      notify?.(new Error('Speech stopped unexpectedly. Press play to start over.'));
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
        // No +1: `total` is the plain sum of unit sizes now, not a joined
        // string length, so a separator character per chunk made progress
        // reach 100% about one chunk early on a long article.
        spoken += unitSize(chunk);
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
    generation += 1;
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
    get engine() { return engine; },
    status: () => status,
    // Units are whatever the engine wants to be handed one at a time: strings
    // of text for the browser voice, `{index, chars}` descriptors for server
    // audio, where the text lives on the server and only the index travels.
    // The player never inspects them beyond their size. §6
    // Swaps the engine without replacing the player. The previous version
    // minted a new player per engine, which meant AppContext's
    // getPlayer().stop(), the component's cached copy and the live player
    // could be three different objects -- so a stop could land on one while
    // another kept talking, and switching article mid-generation left the
    // previous article reading aloud over the new one.
    setEngine(next) {
      if (next === engine) return this;
      stop();
      engine = next;
      return this;
    },

    async speak(text, opts = {}) {
      stop();
      // Captured before the await. A stop() arriving during prepare() -- the
      // reader closed, or stepped to another article -- must not be overtaken
      // by the playback it was cancelling.
      const epoch = generation;
      const next = engine.prepare ? await engine.prepare(text, opts) : chunkText(text);
      if (epoch !== generation) return false;
      if (!next || !next.length) return false;
      handlers = opts;
      chunks = next;
      total = next.reduce((n, unit) => n + unitSize(unit), 0) || 1;
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
//
// Returns the same player it always has: one identity for the life of the app,
// so getPlayer() anywhere and a reference held by a component are the same
// object. Minting a new one here was how a stop could miss.
export function setEngine(engine) {
  return getPlayer().setEngine(engine);
}

// --------------------------------------------------------- Tier 2 engine

// Server-generated speech. §6 / V1-32
//
// The Worker synthesises ~45 seconds at a time and stores none of it, so this
// plays a sequence of short URLs. Three things about that are load-bearing on
// iOS, which is the platform the tier exists for:
//
//   One element, reused. A freshly constructed <audio> calling play() from an
//   `ended` handler has no user activation, and Safari rejects it. The element
//   is created once and only its `src` changes.
//
//   Unlocked inside the click. `unlock()` is called synchronously from the tap
//   that starts playback, before any await, because transient activation does
//   not survive a network round trip.
//
//   Prefetched. Generating a segment takes 8-15 seconds, and with nothing
//   playing in that gap iOS tears down the now-playing session and suspends
//   the page -- so the chain would simply stop on a locked screen. Segment N+1
//   is fetched into a blob while N plays.
export function workersAudioEngine({
  articleId,
  fetchJson,
  makeAudio = () => new globalThis.Audio(),
  fetchAudio = (url) => fetch(url),
  mediaSession = globalThis.navigator?.mediaSession
} = {}) {
  let audio = null;
  let meta = null;
  let units = null;
  let preparedId = null;
  // At most one segment ahead: enough to hide the gap, not enough to generate
  // audio for an article being abandoned.
  let ahead = null;
  let objectUrl = null;

  // How long a stalled download is given to recover before it is called a
  // failure. Long enough to ride out a lift or a tunnel, short enough that the
  // reader is not left in silence wondering.
  const STALL_RECOVERY_MS = 25000;
  let stallTimer = null;

  const clearStall = () => {
    if (stallTimer === null) return;
    globalThis.clearTimeout(stallTimer);
    stallTimer = null;
  };

  const armStall = (report) => {
    if (stallTimer !== null) return;
    stallTimer = globalThis.setTimeout(() => {
      stallTimer = null;
      report(new Error('The audio stopped loading. Check your connection.'));
    }, STALL_RECOVERY_MS);
  };

  const revoke = () => {
    if (!objectUrl) return;
    globalThis.URL?.revokeObjectURL?.(objectUrl);
    objectUrl = null;
  };

  const setState = (state) => {
    if (mediaSession) {
      // iOS renders the lock-screen transport from playbackState rather than
      // inferring it from the element, so without this the button shows the
      // wrong symbol.
      try { mediaSession.playbackState = state; } catch { /* older browsers */ }
    }
  };

  const element = () => {
    if (!audio) {
      audio = makeAudio();
      audio.preload = 'auto';
    }
    return audio;
  };

  const prefetch = (unit) => {
    if (!unit || ahead?.index === unit.index) return;
    // Every failure here is survivable: the segment is simply fetched normally
    // when its turn comes. fetch() can also throw synchronously rather than
    // rejecting, so the call itself is inside the try.
    try {
      ahead = {
        index: unit.index,
        blob: Promise.resolve(fetchAudio(unit.url))
          .then((res) => (res?.ok ? res.blob() : null))
          .catch(() => null)
      };
    } catch {
      ahead = null;
    }
  };

  return {
    available: typeof globalThis.Audio === 'function',

    // Called synchronously from the click that starts playback. Playing a
    // moment of silence is what marks the element as user-initiated, so every
    // later src change may play without a gesture of its own.
    unlock() {
      const el = element();
      try {
        el.muted = true;
        const started = el.play?.();
        if (started?.then) started.then(() => { el.pause?.(); el.muted = false; }, () => { el.muted = false; });
        else { el.pause?.(); el.muted = false; }
      } catch {
        el.muted = false;
      }
    },

    async prepare(text, opts = {}) {
      const id = opts.articleId ?? articleId;
      if (!id) return null;
      if (units && preparedId === id) return units;
      const manifest = await fetchJson(`/api/articles/${id}/audio`);
      // `available: false` is an answer, not a failure: too long, no text, no
      // AI binding, or the day's limit reached. The caller falls back.
      if (!manifest?.available || !manifest.segments) return null;
      meta = manifest;
      preparedId = id;
      units = Array.from({ length: manifest.segments }, (_, index) => ({
        index,
        chars: manifest.segmentChars?.[index] ?? 1,
        url: `/api/articles/${id}/audio/${index}`
      }));
      return units;
    },

    speak(unit, { onEnd, onError, onBoundary } = {}) {
      const el = element();
      revoke();

      // A play() promise that is still pending when we pause or move on
      // rejects with AbortError. That is us interrupting deliberately, not a
      // failure, and routing it to onError would toast a DOM message and reset
      // the reader's place.
      const mine = unit.index;
      const guard = (err) => {
        if (err?.name === 'AbortError') return;
        if (ahead?.index !== undefined && mine !== unit.index) return;
        onError?.(err instanceof Error ? err : new Error('That part of the audio could not be played.'));
      };

      const start = (src) => {
        el.src = src;
        el.ontimeupdate = () => {
          if (!el.duration || !Number.isFinite(el.duration)) return;
          onBoundary?.(Math.round((el.currentTime / el.duration) * unit.chars));
          // Begin the next segment once this one is genuinely under way.
          if (el.currentTime > 1 && units) prefetch(units[unit.index + 1]);
        };
        el.onended = () => { clearStall(); setState('paused'); onEnd?.(); };
        el.onerror = () => guard(new Error('That part of the audio could not be played.'));
        // A download that stalls fires neither `ended` nor `error`, so the
        // player's watchdog -- derived from character count -- is minutes away.
        // These are the element's own signals that the network, not the
        // synthesiser, is the problem. Reporting a boundary here would be
        // actively wrong: a boundary means progress and re-arms the watchdog.
        el.onstalled = () => armStall(guard);
        el.onwaiting = () => armStall(guard);
        el.onplaying = clearStall;
        el.oncanplay = clearStall;

        const started = el.play?.();
        if (started?.catch) started.catch(guard);
        setState('playing');
      };

      if (mediaSession && meta) {
        try {
          mediaSession.metadata = new globalThis.MediaMetadata({
            title: meta.title || 'NeatInfo',
            artist: meta.source || '',
            album: 'NeatInfo'
          });
        } catch { /* MediaMetadata missing; audio still plays */ }
      }

      // Use the prefetched blob when this is the segment we ran ahead on.
      if (ahead?.index === unit.index) {
        const pending = ahead.blob;
        ahead = null;
        pending.then((blob) => {
          if (blob && globalThis.URL?.createObjectURL) {
            objectUrl = globalThis.URL.createObjectURL(blob);
            start(objectUrl);
          } else {
            start(unit.url);
          }
        }).catch(() => start(unit.url));
        return;
      }
      start(unit.url);
    },

    pause() { clearStall(); setState('paused'); audio?.pause(); },
    resume() { setState('playing'); audio?.play?.()?.catch?.((err) => { if (err?.name !== 'AbortError') throw err; }); },
    cancel() {
      clearStall();
      setState('none');
      ahead = null;
      revoke();
      if (!audio) return;
      audio.ontimeupdate = null;
      audio.onended = null;
      audio.onerror = null;
      audio.onstalled = null;
      audio.onwaiting = null;
      audio.pause?.();
      // Dropping the src stops a segment still downloading; without it an
      // abandoned article keeps pulling audio nobody will hear, at 88 KB/s.
      audio.removeAttribute?.('src');
      audio.load?.();
    }
  };
}

// ------------------------------------------------------- choosing a tier

// Which voice an article gets. Extracted from the component deliberately: this
// is the decision the whole tier turns on -- server audio when the Worker can
// produce it, the browser's own voice when it cannot -- and inside a React
// component with no jsdom in the project it could not be tested at all.
//
// Returns the engine to use and why, so the caller can label it honestly.
export async function chooseEngine({ articleId, fetchJson, makeServerEngine, makeDeviceEngine }) {
  const device = () => ({ engine: makeDeviceEngine(), voice: 'device' });

  const server = makeServerEngine?.({ articleId, fetchJson });
  if (!server?.available) return device();

  // unlock() must happen inside the click that triggered this, before any
  // await: Safari's transient activation does not survive a network round
  // trip, and an element first played after one is rejected.
  server.unlock?.();

  let units = null;
  try {
    units = await server.prepare(null, { articleId });
  } catch {
    // A thrown prepare is the same answer as `available: false`.
    units = null;
  }
  if (!units?.length) {
    server.cancel?.();
    return device();
  }
  return { engine: server, voice: 'server' };
}
