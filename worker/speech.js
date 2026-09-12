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

    // A paragraph longer than a segment is split at sentence ends, and only
    // at word boundaries if a single "sentence" is still too long (a URL, a
    // run-on). Never mid-word: the synthesiser would pronounce the fragments.
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

// base64 -> bytes. atob is available on workerd; this is the only decoding
// step, and it exists because the model returns text rather than audio.
export function decodeAudio(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Returns the WAV bytes for one segment, or throws. The caller decides what a
// failure means -- for the reader it means falling back to the browser voice,
// which is why Tier 1 is kept rather than removed.
export async function generateSegment(env, prompt) {
  const result = await env.AI.run(MODEL, { prompt, lang: 'en' });

  // Documented as binary audio/mpeg, actually `{ audio: base64 }`. Both shapes
  // are handled because the documentation says one thing, the API does
  // another, and either could change.
  if (result && typeof result === 'object' && typeof result.audio === 'string') {
    return decodeAudio(result.audio);
  }
  if (result instanceof ReadableStream) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return result;

  throw new Error('Workers AI returned audio in an unrecognised shape.');
}
