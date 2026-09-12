// V1-32. Tier 2 speech, with env.AI stubbed -- these tests must never spend a
// neuron, and must never depend on Workers AI being reachable.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, call, callJson, resetDb, seedArticle } from './helpers.js';
import { segmentText, speechText, decodeAudio, SEGMENT_CHARS, MAX_SEGMENTS } from '../worker/speech.js';

beforeAll(applySchema);
beforeEach(resetDb);

const realAI = env.AI;
afterEach(() => { env.AI = realAI; });

// A minimal WAV: the client only needs bytes that an <audio> element accepts,
// and the tests only need to know they arrived unmangled.
function fakeWavBase64(marker = 'RIFF') {
  const bytes = new TextEncoder().encode(marker + 'x'.repeat(20));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function stubAI({ onRun } = {}) {
  const calls = [];
  env.AI = {
    async run(model, input) {
      calls.push({ model, input });
      if (onRun) return onRun(model, input);
      return { audio: fakeWavBase64() };
    }
  };
  return calls;
}

describe('segmentText', () => {
  it('keeps a short article in one segment', () => {
    expect(segmentText('A short piece of text.')).toEqual(['A short piece of text.']);
  });

  it('returns nothing for empty input', () => {
    expect(segmentText('')).toEqual([]);
    expect(segmentText(null)).toEqual([]);
    expect(segmentText('   \n\n  ')).toEqual([]);
  });

  it('never exceeds the segment size', () => {
    const para = 'This sentence is a reasonable length for ordinary prose. ';
    const segments = segmentText(para.repeat(80));
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
  });

  it('prefers paragraph boundaries, because a segment join is audible', () => {
    const a = 'First paragraph, comfortably short.';
    const b = 'Second paragraph, also short.';
    expect(segmentText(`${a}\n\n${b}`)).toEqual([`${a} ${b}`]);

    // Two paragraphs that cannot share a segment are split between them.
    const long = 'word '.repeat(150).trim();
    const segments = segmentText(`${long}\n\n${long}`);
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('splits a single over-long sentence at word boundaries, never mid-word', () => {
    const segments = segmentText('word '.repeat(400).trim());
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
      expect(s.startsWith(' ')).toBe(false);
      expect(s).not.toMatch(/\bwor$|\bwo$/);
    }
    // Nothing is dropped on the way through.
    expect(segments.join(' ').split(/\s+/).length).toBe(400);
  });

  it('loses no words from ordinary prose', () => {
    const text = Array.from({ length: 12 }, (_, i) =>
      `Paragraph ${i} says something of moderate length about the subject at hand.`).join('\n\n');
    const words = text.split(/\s+/).filter(Boolean).length;
    expect(segmentText(text).join(' ').split(/\s+/).filter(Boolean).length).toBe(words);
  });
});

describe('speechText', () => {
  it('puts the title first, so a locked screen says what is playing', () => {
    expect(speechText({ title: 'A Title', body_text: 'The body.' })).toBe('A Title.\n\nThe body.');
  });

  it('falls back to the title alone when there is no body', () => {
    expect(speechText({ title: 'A Title', body_text: null })).toBe('A Title.');
  });

  it('is empty when there is nothing to say', () => {
    expect(speechText({ title: '', body_text: '' })).toBe('');
    expect(speechText(null)).toBe('');
  });
});

describe('decodeAudio', () => {
  it('round-trips bytes through base64 unchanged', () => {
    const decoded = decodeAudio(fakeWavBase64('RIFF'));
    expect(new TextDecoder().decode(decoded).startsWith('RIFF')).toBe(true);
  });
});

describe('GET /api/articles/:id/audio (manifest)', () => {
  it('reports the segment count for an article with text', async () => {
    stubAI();
    const { id } = await seedArticle({ title: 'A Title', body_text: 'Some body text to read aloud.' });

    const { body, status } = await callJson(`/api/articles/${id}/audio`);

    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.segments).toBe(1);
    expect(body.title).toBe('A Title');
  });

  it('says so, rather than failing, when Workers AI is not configured', async () => {
    // The client asks first precisely so it can fall back to the browser voice
    // without a failed request.
    env.AI = undefined;
    const { id } = await seedArticle({ body_text: 'Some body text.' });

    const { body, status } = await callJson(`/api/articles/${id}/audio`);

    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/not configured/i);
  });

  it('refuses an article too long to read aloud, and says how long', async () => {
    // Refusing beats truncating: reading three quarters of a paper and
    // stopping without explanation is worse than declining.
    stubAI();
    const { id } = await seedArticle({ body_text: 'word '.repeat(MAX_SEGMENTS * SEGMENT_CHARS / 4) });

    const { body } = await callJson(`/api/articles/${id}/audio`);

    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/too long/i);
    expect(body.segments).toBeGreaterThan(MAX_SEGMENTS);
  });

  it('has nothing to offer for an article with no text', async () => {
    stubAI();
    const { id } = await seedArticle({ title: '', body_text: null });

    const { body } = await callJson(`/api/articles/${id}/audio`);

    expect(body.available).toBe(false);
    expect(body.segments).toBe(0);
  });

  it('404s for an article that does not exist', async () => {
    stubAI();
    const { status } = await callJson('/api/articles/99999/audio');
    expect(status).toBe(404);
  });
});

describe('GET /api/articles/:id/audio/:seg', () => {
  it('returns wav bytes for a segment', async () => {
    const calls = stubAI();
    const { id } = await seedArticle({ title: 'A Title', body_text: 'Some body text to read aloud.' });

    const res = await call(`/api/articles/${id}/audio/0`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes).startsWith('RIFF')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.prompt).toContain('A Title');
  });

  it('404s past the end of the range, so the client can detect the end', async () => {
    // An empty 200 would play as silence and look like a working segment.
    stubAI();
    const { id } = await seedArticle({ body_text: 'Short.' });

    expect((await call(`/api/articles/${id}/audio/1`)).status).toBe(404);
    expect((await call(`/api/articles/${id}/audio/99`)).status).toBe(404);
  });

  it('503s rather than 500s when Workers AI is not configured', async () => {
    env.AI = undefined;
    const { id } = await seedArticle({ body_text: 'Some body text.' });

    expect((await call(`/api/articles/${id}/audio/0`)).status).toBe(503);
  });

  it('502s when generation fails, cleanly enough for the client to fall back', async () => {
    stubAI({ onRun: () => { throw new Error('model unavailable'); } });
    const { id } = await seedArticle({ body_text: 'Some body text.' });

    const res = await call(`/api/articles/${id}/audio/0`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/model unavailable/);
  });

  it('rejects an unrecognised response shape instead of serving garbage', async () => {
    stubAI({ onRun: () => ({ something: 'else' }) });
    const { id } = await seedArticle({ body_text: 'Some body text.' });

    expect((await call(`/api/articles/${id}/audio/0`)).status).toBe(502);
  });

  it('writes nothing to R2 -- the whole point of the design', async () => {
    stubAI();
    const { id } = await seedArticle({ body_text: 'Some body text to read aloud.' });

    const before = (await env.RAW.list({ limit: 1000 })).objects.length;
    await call(`/api/articles/${id}/audio/0`);
    const after = (await env.RAW.list({ limit: 1000 })).objects.length;

    expect(after).toBe(before);
  });

  it('requires a session, like every other article route', async () => {
    stubAI();
    const { id } = await seedArticle({ body_text: 'Some body text.' });

    expect((await call(`/api/articles/${id}/audio/0`, {}, { authed: false })).status).toBe(401);
    expect((await call(`/api/articles/${id}/audio`, {}, { authed: false })).status).toBe(401);
  });
});
