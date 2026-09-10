import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, resetDb, seedArticle } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);

describe('harness', () => {
  it('applies schema.sql to a real local D1', async () => {
    const row = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'article'`
    ).first();
    expect(row?.name).toBe('article');
  });

  it('inserts an article and reads it back', async () => {
    const seeded = await seedArticle({ title: 'Round trip' });
    const row = await env.DB.prepare(`SELECT title, status FROM article WHERE id = ?1`)
      .bind(seeded.id).first();
    expect(row.title).toBe('Round trip');
    expect(row.status).toBe('new');
  });

  it('indexes new articles into FTS via the schema trigger', async () => {
    await seedArticle({ title: 'Transformers explained', body_text: 'attention is all you need' });
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM article_fts WHERE article_fts MATCH 'transformers'`
    ).first();
    expect(row.n).toBe(1);
  });

  it('binds R2 as well as D1', async () => {
    expect(env.RAW).toBeDefined();
    await env.RAW.put('smoke.txt', 'hello');
    expect(await (await env.RAW.get('smoke.txt')).text()).toBe('hello');
  });
});
