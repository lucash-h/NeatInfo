// V1-24 -- export round-trip and completeness. The archive's entire value is
// lost if a restore silently drops rows or loses ids that article_tag and
// event.article_id depend on, so this asserts row-for-row equality after a
// full export -> wipe -> reimport cycle, not just "the importer ran."
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, call, callJson, resetDb, seedArticle } from './helpers.js';
import { buildImportStatements, renderStatement, sqlLiteral } from '../worker/importer.js';

beforeAll(applySchema);
beforeEach(resetDb);

async function tagArticle(id, names) {
  for (const name of names) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tag (name) VALUES (?1)`).bind(name).run();
    await env.DB.prepare(
      `INSERT INTO article_tag (article_id, tag_id) VALUES (?1, (SELECT id FROM tag WHERE name = ?2))`
    ).bind(id, name).run();
  }
}

async function addEvent(articleId, type) {
  await env.DB.prepare(`INSERT INTO event (article_id, type) VALUES (?1, ?2)`).bind(articleId, type).run();
}

// Seeds real variety: all four statuses, a favorite, notes, a raw_html_key, a
// pasted (null-url) article, shared tags across articles, several event
// types, and a non-default setting -- everything the acceptance list asks the
// round trip to preserve.
async function seedVariety() {
  const a1 = await seedArticle({ title: 'Scaling laws revisited', source: 'arxiv.org', status: 'kept', favorite: 1 });
  const a2 = await seedArticle({ title: 'A dismissed piece', source: 'example.com', status: 'dismissed' });
  const a3 = await seedArticle({ title: 'Notes on retrieval', source: 'example.com', status: 'lapsed', notes: 'Come back to this after §8.' });
  const a4 = await seedArticle({ title: 'Raw capture kept', source: 'blog.example', status: 'new', raw_html_key: 'raw/2026/09/abc123.html' });
  const a5 = await seedArticle({ title: 'Pasted, no source url', source: 'pasted', url: null, url_normalized: null, status: 'new' });

  await tagArticle(a1.id, ['ml', 'favorites']);
  await tagArticle(a3.id, ['ml']);

  await addEvent(a1.id, 'added');
  await addEvent(a1.id, 'starred');
  await addEvent(a2.id, 'added');
  await addEvent(a2.id, 'dismissed');
  await addEvent(a3.id, 'added');
  await addEvent(a3.id, 'lapsed');
  await addEvent(a4.id, 'added');
  await addEvent(a5.id, 'added');

  await env.DB.prepare(
    `INSERT INTO setting (key, value) VALUES ('lapse_window_days', '30')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run();

  return { a1, a2, a3, a4, a5 };
}

async function fetchExport() {
  const { res, body } = await callJson('/api/export');
  expect(res.status).toBe(200);
  return body;
}

async function runImport(payload) {
  const statements = buildImportStatements(payload);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.binds)));
}

async function allRows(table) {
  const res = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return res.results;
}

describe('GET /api/export', () => {
  it('carries settings, topics and a raw_html_keys manifest alongside the existing fields', async () => {
    await seedVariety();
    const payload = await fetchExport();

    expect(payload.schema_version).toBe(1);
    expect(Array.isArray(payload.articles)).toBe(true);
    expect(Array.isArray(payload.events)).toBe(true);
    expect(Array.isArray(payload.article_tags)).toBe(true);

    expect(payload.settings).toEqual(
      expect.arrayContaining([{ key: 'lapse_window_days', value: '30' }])
    );
    expect(payload.topics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 1, name: 'AI' })])
    );
  });

  it('lists raw_html_keys as exactly the articles’ non-null keys', async () => {
    const { a4 } = await seedVariety();
    const payload = await fetchExport();
    expect(payload.raw_html_keys).toEqual([a4.raw_html_key]);
  });
});

describe('export -> wipe -> reimport round trip', () => {
  it('reproduces article, event, tag and setting rows exactly, ids included', async () => {
    await seedVariety();
    const payload = await fetchExport();

    const articlesBefore = await allRows('article');
    const eventsBefore = await allRows('event');
    const settingsBefore = (await env.DB.prepare(`SELECT * FROM setting ORDER BY key`).all()).results;
    const tagPairsBefore = (
      await env.DB.prepare(
        `SELECT at.article_id, t.name FROM article_tag at JOIN tag t ON t.id = at.tag_id ORDER BY at.article_id, t.name`
      ).all()
    ).results;

    await resetDb();
    expect(await allRows('article')).toEqual([]);

    await runImport(payload);

    expect(await allRows('article')).toEqual(articlesBefore);
    expect(await allRows('event')).toEqual(eventsBefore);
    expect((await env.DB.prepare(`SELECT * FROM setting ORDER BY key`).all()).results).toEqual(settingsBefore);
    expect(
      (
        await env.DB.prepare(
          `SELECT at.article_id, t.name FROM article_tag at JOIN tag t ON t.id = at.tag_id ORDER BY at.article_id, t.name`
        ).all()
      ).results
    ).toEqual(tagPairsBefore);
  });

  it('keeps the archive searchable: a term that matched before restore still matches after', async () => {
    // q only searches the resolved archive (getFeed), not the new-item feeds.
    await seedArticle({
      title: 'Retrieval augmented kangaroos',
      source: 'arxiv.org',
      status: 'kept',
      resolved_at: new Date().toISOString(),
      body_text: 'A survey of kangaroo-based retrieval methods.'
    });
    const payload = await fetchExport();

    const dayStart = encodeURIComponent(new Date().toISOString());
    const before = await callJson(`/api/feed?dayStart=${dayStart}&q=kangaroo`);
    expect(before.body.archive.length).toBe(1);

    await resetDb();
    await runImport(payload);

    const after = await callJson(`/api/feed?dayStart=${dayStart}&q=kangaroo`);
    expect(after.body.archive.length).toBe(1);
    expect(after.body.archive[0].title).toBe('Retrieval augmented kangaroos');
  });

  it('imports an older payload missing settings, topics and raw_html_keys without throwing', async () => {
    await seedVariety();
    const payload = await fetchExport();
    delete payload.settings;
    delete payload.topics;
    delete payload.raw_html_keys;

    await resetDb();
    await expect(runImport(payload)).resolves.not.toThrow();

    // The rows that the old export shape did carry still round-trip.
    const articles = await allRows('article');
    expect(articles.length).toBe(payload.articles.length);
  });
});

describe('renderStatement / sqlLiteral (scripts/import.mjs SQL text output)', () => {
  it('preserves whitespace inside a literal byte-for-byte -- the bug this exists to catch', () => {
    // Collapsing whitespace on the RENDERED statement (instead of the SQL
    // template, before literals are inlined) flattens paragraph breaks, tabs
    // and multi-space runs inside body_text/notes/summary. That is silent
    // data corruption on restore, which is exactly what this test guards.
    const body = 'First paragraph.\n\nSecond paragraph.\tTabbed.   Three spaces.';
    const rendered = renderStatement({
      sql: `INSERT INTO article (id, body_text) VALUES (?1, ?2)`,
      binds: [1, body]
    });
    expect(rendered).toContain(`'${body.replace(/'/g, "''")}'`);
  });

  it('doubles a single quote inside a literal so it round-trips', () => {
    expect(sqlLiteral("O'Brien's notes")).toBe("'O''Brien''s notes'");
    const rendered = renderStatement({ sql: `INSERT INTO t (name) VALUES (?1)`, binds: ["O'Brien"] });
    expect(rendered).toBe(`INSERT INTO t (name) VALUES ('O''Brien');`);
  });

  it('renders null, number and boolean binds as NULL, a bare digit, and 1/0', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral(false)).toBe('0');
  });

  // The test that would have caught the original bug: it executes the CLI's
  // actual .sql-file output, not the bound statements the rest of this file
  // exercises, against a fresh D1.
  it('a rendered statement list executes against a fresh D1 and reproduces the bound-path rows', async () => {
    const a1 = await seedArticle({
      title: 'Whitespace-sensitive body',
      source: 'example.com',
      body_text: 'Para one.\n\nPara two.\tTabbed.   Spaced.',
      notes: "Contains a ' quote"
    });
    await tagArticle(a1.id, ['ml']);
    await addEvent(a1.id, 'added');

    const payload = await fetchExport();
    const statements = buildImportStatements(payload);
    const rendered = statements.map(renderStatement);

    const boundArticles = await allRows('article');

    await resetDb();
    for (const sql of rendered) {
      await env.DB.prepare(sql).run();
    }

    expect(await allRows('article')).toEqual(boundArticles);
    const tagPairs = (
      await env.DB.prepare(
        `SELECT at.article_id, t.name FROM article_tag at JOIN tag t ON t.id = at.tag_id ORDER BY at.article_id, t.name`
      ).all()
    ).results;
    expect(tagPairs).toEqual([{ article_id: a1.id, name: 'ml' }]);
  });
});
