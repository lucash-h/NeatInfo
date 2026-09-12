// Tier 2 speech: server-generated audio, made while you listen and kept
// nowhere. §6 / V1-32
//
// `@cf/myshell-ai/melotts` returns `{ audio: "<base64>" }` wrapping 44.1kHz
// 16-bit mono WAV -- not the MP3 the model documentation claims. That is 88 KB
// per second, so a 48-minute article would be 252 MB of audio. Caching it was
// the original plan and is now plainly wrong: §9.7 says capture what is cheap
// and irreplaceable, and generated audio is expensive and reproducible, which
// is the exact opposite.
//
// So nothing is stored. A segment is generated when the reader reaches it and
// discarded when it has been played. Neurons are not the constraint -- 18.63
// per audio minute against 10,000 free a day -- bandwidth is, and it is only
// spent on audio actually listened to.

export const MODEL = '@cf/myshell-ai/melotts';

// ~800 characters is about a minute of speech at 15 characters a second, which
// is one AI call of roughly eight seconds. Long enough that the calls are not
// constant, short enough that abandoning an article halfway wastes at most a
// minute of generation.
export const SEGMENT_CHARS = 800;

// A ceiling on one article, so a 48-minute paper cannot quietly consume the
// day's allowance if something loops. 60 segments is about an hour of audio,
// well beyond any single sitting.
export const MAX_SEGMENTS = 60;

// Paragraph-aware, then sentence-aware, then word-aware. A segment boundary is
// audible -- there is a real pause between two <audio> elements -- so it should
// land where the prose already pauses. body_text preserves paragraph breaks
// from extraction, which is what makes the first pass possible.
export function segmentText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const segments = [];
  let buf = '';

  const flush = () => {
    const t = buf.trim();
    if (t) segments.push(t);
    buf = '';
  };

  for (const paragraph of clean.split(/\n{2,}/)) {
    const para = paragraph.replace(/\s+/g, ' ').trim();
    if (!para) continue;

    if (buf && (buf.length + para.length + 1) > SEGMENT_CHARS) flush();

    if (para.length <= SEGMENT_CHARS) {
      buf = buf ? `${buf} ${para}` : para;
      continue;
    }

    // A paragraph longer than a segment is split at sentence ends, then at
    // word boundaries if a single "sentence" is still too long (a URL, a
    // run-on). A token longer than a whole segment -- a 900-character URL --
    // is cut mid-token, because there is nowhere better to cut it.
    flush();
    for (const sentence of para.match(/[^.!?]+[.!?]*\s*/g) || [para]) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length > SEGMENT_CHARS) {
        flush();
        let rest = s;
        while (rest.length > SEGMENT_CHARS) {
          const cut = rest.lastIndexOf(' ', SEGMENT_CHARS);
          const at = cut > SEGMENT_CHARS * 0.5 ? cut : SEGMENT_CHARS;
          segments.push(rest.slice(0, at).trim());
          rest = rest.slice(at).trim();
        }
        buf = rest;
        continue;
      }
      if ((buf + ' ' + s).trim().length > SEGMENT_CHARS) flush();
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  flush();
  return segments;
}

// The text spoken for an article: the title first, so a locked screen and a
// mid-article resume both tell you what you are listening to.
export function speechText(article) {
  const title = (article?.title || '').trim();
  const body = (article?.body_text || '').trim();
  if (!body) return title ? `${title}.` : '';
  return title ? `${title}.\n\n${body}` : body;
}

// base64 -> bytes, natively. The model returns text rather than audio, so this
// runs on every segment: a 45-second segment is ~4 MB of WAV, which is a 5.3
// million character base64 string.
//
// The obvious `atob` + charCodeAt loop is a four-million-iteration JS loop,
// measured at ~14ms on a warm desktop core. The free plan allows **10ms of CPU
// per invocation** and edge cores are slower, so that version would have
// returned 1102 "exceeded CPU time limit" for every segment in production --
// and could never fail locally, because `wrangler dev` does not enforce the
// limit. Both paths below decode in C++ and are O(1) JS.
export function decodeAudio(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
  // Older runtimes: the data: URL decoder is also native. Async, so callers
  // that hit this path await it -- generateSegment does.
  return fetch(`data:application/octet-stream;base64,${base64}`)
    .then((res) => res.arrayBuffer())
    .then((buf) => new Uint8Array(buf));
}

// Returns the WAV bytes for one segment, or throws. The caller decides what a
// failure means -- for the reader it means falling back to the browser voice,
// which is why Tier 1 is kept rather than removed.
export async function generateSegment(env, prompt) {
  const result = await env.AI.run(MODEL, { prompt, lang: 'en' });

  // Documented as binary audio/mpeg, actually `{ audio: base64 }`. Both shapes
  // are handled because the documentation says one thing, the API does
  // another, and either could change.
  // `await` covers both decodeAudio paths: native returns bytes, the data: URL
  // fallback returns a promise.
  if (result && typeof result === 'object' && typeof result.audio === 'string') {
    return { body: await decodeAudio(result.audio), contentType: 'audio/wav' };
  }
  // The documented shape, which the model does not currently produce. It is
  // documented as MPEG, so it is labelled as MPEG rather than mislabelled wav
  // -- handling a shape you cannot label correctly is not handling it.
  if (result instanceof ReadableStream) return { body: result, contentType: 'audio/mpeg' };
  if (result instanceof ArrayBuffer) return { body: new Uint8Array(result), contentType: 'audio/mpeg' };
  if (result instanceof Uint8Array) return { body: result, contentType: 'audio/mpeg' };

  throw new Error('Workers AI returned audio in an unrecognised shape.');
}
