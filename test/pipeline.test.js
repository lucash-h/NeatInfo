// V1-33. The two keyed routes that hand work to the Python pipeline and take
// features back, plus the canary that makes a silently-dead nightly job
// visible.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, call, callJson, resetDb, seedArticle } from './helpers.js';

beforeAll(applySchema);
beforeEach(async () => {
  await resetDb();
  await env.DB.prepare(`DELETE FROM article_feature`).run();
});

const KEY = { 'x-discover-key': 'test-discover-key' };
const V = 'stage1-test';

const work = (params = '', headers = KEY) =>
  callJson(`/api/pipeline/work?${new URLSearchParams({ version: V, ...params })}`, { headers });

const send = (body, headers = KEY) =>
  callJson('/api/pipeline/features', { method: 'POST', headers, body: JSON.stringify(body) });

describe('pipeline auth', () => {
  it('refuses a missing or wrong key', async () => {
    expect((await call(`/api/pipeline/work?version=${V}`, { headers: {} })).status).toBe(401);
    expect((await call(`/api/pipeline/work?version=${V}`, { headers: { 'x-discover-key': 'nope' } })).status).toBe(401);
  });

  it('does not accept a session cookie instead', async () => {
    // These routes are for a machine. Letting a browser session through would
    // widen the surface for no reason.
    expect((await call(`/api/pipeline/work?version=${V}`)).status).toBe(401);
  });

  it('404s an unknown pipeline route rather than falling through', async () => {
    expect((await call('/api/pipeline/nonsense', { headers: KEY })).status).toBe(404);
  });
});

describe('GET /api/pipeline/work', () => {
  it('hands out articles that have text and no features at this version', async () => {
    const a = await seedArticle({ title: 'Has text', body_text: 'Some body text.' });
    await seedArticle({ title: 'No text', body_text: null });

    const { body } = await work();

    expect(body.articles).toHaveLength(1);
    expect(body.articles[0].id).toBe(a.id);
    expect(body.articles[0].body_text).toBe('Some body text.');
    expect(body.remaining).toBe(1);
  });

  it('stops handing out an article once it has features at that version', async () => {
    const { id } = await seedArticle({ body_text: 'Some body text.' });

    await send({ version: V, features: [{ article_id: id, score: 50, explain: 'ok', payload: {} }] });
    const { body } = await work();

    expect(body.articles).toHaveLength(0);
    expect(body.remaining).toBe(0);
  });

  it('hands it out again at a new version, which is how a re-score happens', async () => {
    // A changed extractor bumps its version; nothing has to track staleness.
    const { id } = await seedArticle({ body_text: 'Some body text.' });
    await send({ version: V, features: [{ article_id: id, score: 50, explain: 'ok', payload: {} }] });

    const { body } = await work({ version: 'stage1-next' });

    expect(body.articles.map((a) => a.id)).toEqual([id]);
  });

  it('requires a version, since work without one is meaningless', async () => {
    const { status } = await callJson('/api/pipeline/work', { headers: KEY });
    expect(status).toBe(400);
  });

  it('clamps the batch size rather than letting a caller ask for everything', async () => {
    for (let i = 0; i < 5; i += 1) await seedArticle({ body_text: `Body ${i}.` });

    const { body } = await work({ limit: '2' });
    expect(body.articles).toHaveLength(2);
    expect(body.remaining).toBe(5);

    const { body: big } = await work({ limit: '9999' });
    expect(big.articles.length).toBeLessThanOrEqual(200);
  });

  it('carries the raw capture key, so the client knows whether to fetch HTML', async () => {
    await seedArticle({ body_text: 'Body.', raw_html_key: 'raw/abc.html' });
    const { body } = await work();
    expect(body.articles[0].raw_html_key).toBe('raw/abc.html');
  });
});

describe('POST /api/pipeline/features', () => {
  it('stores a score, an explanation and the signals', async () => {
    const { id } = await seedArticle({ body_text: 'Body.' });

    const { body } = await send({
      version: V,
      features: [{ article_id: id, score: 87.5, explain: 'specific +25', payload: { words: 400 } }]
    });
    expect(body.accepted).toBe(1);

    const row = await env.DB.prepare(
      `SELECT score, explain, payload FROM article_feature WHERE article_id = ?1 AND version = ?2`
    ).bind(id, V).first();
    expect(row.score).toBeCloseTo(87.5);
    expect(row.explain).toBe('specific +25');
    expect(JSON.parse(row.payload).words).toBe(400);
  });

  it('is idempotent: the same run twice leaves one row', async () => {
    // The client will be interrupted -- Actions runners get killed, networks
    // fail -- so a re-run has to be ordinary rather than a problem.
    const { id } = await seedArticle({ body_text: 'Body.' });
    const row = { article_id: id, score: 10, explain: 'first', payload: {} };

    await send({ version: V, features: [row] });
    await send({ version: V, features: [{ ...row, score: 20, explain: 'second' }] });

    const { results } = await env.DB.prepare(
      `SELECT score, explain FROM article_feature WHERE article_id = ?1`
    ).bind(id).all();
    expect(results).toHaveLength(1);
    expect(results[0].explain).toBe('second');
  });

  it('keeps versions side by side rather than overwriting across them', async () => {
    // Scores from two versions are not comparable, and once they share a row
    // that difference is invisible. Stage 5 needs both.
    const { id } = await seedArticle({ body_text: 'Body.' });
    await send({ version: 'v1', features: [{ article_id: id, score: 10, explain: 'a', payload: {} }] });
    await send({ version: 'v2', features: [{ article_id: id, score: 90, explain: 'b', payload: {} }] });

    const { results } = await env.DB.prepare(
      `SELECT version, score FROM article_feature WHERE article_id = ?1 ORDER BY version`
    ).bind(id).all();
    expect(results.map((r) => r.version)).toEqual(['v1', 'v2']);
  });

  it('rejects an empty or unusable batch', async () => {
    expect((await send({ version: V, features: [] })).status).toBe(400);
    expect((await send({ version: V })).status).toBe(400);
    expect((await send({ features: [{ article_id: 1, score: 1 }] })).status).toBe(400);
    expect((await send({ version: V, features: [{ score: 1 }] })).status).toBe(400);
  });

  it('stores nothing for an article that does not exist', async () => {
    // Checked in code rather than left to the foreign key: D1's enforcement is
    // configuration, and the test harness strips PRAGMA from schema.sql, so
    // relying on it would mean asserting a property of the environment rather
    // than of this worker.
    const res = await send({ version: V, features: [{ article_id: 99999, score: 1, explain: '', payload: {} }] });
    expect(res.status).toBe(400);

    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM article_feature`).first();
    expect(row.n).toBe(0);
  });

  it('stores the real articles in a batch and reports the ones it skipped', async () => {
    const { id } = await seedArticle({ body_text: 'Body.' });

    const { body } = await send({
      version: V,
      features: [
        { article_id: id, score: 5, explain: 'ok', payload: {} },
        { article_id: 99999, score: 5, explain: 'ghost', payload: {} }
      ]
    });

    expect(body.accepted).toBe(1);
    expect(body.skipped).toBe(1);
  });
});

describe('the canary', () => {
  it('records when the pipeline last ran, how much it did, and at what version', async () => {
    // A nightly job that quietly stops is invisible for a week. The count is
    // separate from the timestamp so "it ran" and "it did anything" are
    // different questions.
    const { id } = await seedArticle({ body_text: 'Body.' });
    await send({ version: V, features: [{ article_id: id, score: 1, explain: 'x', payload: {} }] });

    const { body } = await callJson('/api/settings');

    expect(body.pipelineLastRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.pipelineLastCount).toBe(1);
    expect(body.pipelineVersion).toBe(V);
  });

  it('reports nothing rather than a fake timestamp before the first run', async () => {
    const { body } = await callJson('/api/settings');
    expect(body.pipelineLastRun).toBe(null);
    expect(body.pipelineLastCount).toBe(0);
  });
});
