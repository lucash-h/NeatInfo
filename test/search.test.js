// §3 "Store": search over the archive. The point of this file is success
// criterion 4 -- ordinary punctuation used to reach fts5 as syntax and come
// back as a 500, which is the single most likely way normal use looks broken.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, callJson, resetDb, seedArticle } from './helpers.js';
import { ftsQuery, buildArchiveQuery } from '../worker/search.js';

beforeAll(applySchema);
beforeEach(resetDb);

const search = (q) =>
  callJson(`/api/feed?q=${encodeURIComponent(q)}&dayStart=${new Date().toISOString()}`);

async function seedArchive() {
  await seedArticle({
    title: 'GPT (4) and the cost-benefit of scaling',
    source: 'example.com',
    summary: 'A note on title:x and other punctuation.',
    body_text: 'Training runs are expensive; a cost-benefit view helps. AND OR NOT NEAR are words too.',
    status: 'kept',
    resolved_at: new Date().toISOString()
  });
  await seedArticle({
    title: 'Unrelated gardening notes',
    source: 'garden.example',
    body_text: 'Tomatoes want sun and consistent water.',
    status: 'dismissed',
    resolved_at: new Date().toISOString()
  });
}

// Every one of these used to be capable of producing an fts5 syntax error,
// which the router turned into a 500.
const HOSTILE = [
  'gpt (4)',
  'cost-benefit',
  'title:x',
  '"',
  '***',
  'AND',
  'a NEAR b',
  '',
  '   ',
  'OR OR OR',
  'NOT',
  '^caret',
  'a AND (b OR c)',
  'quote"inside',
  "it's",
  '-leading-dash',
  '{}[]()<>',
  'emoji 🐈 search',
  'sql\' OR 1=1 --',
  'a'.repeat(500),
  'x '.repeat(60)
];

describe('hostile search strings', () => {
  it(`puts ${HOSTILE.length} hostile strings through search without a 5xx`, async () => {
    await seedArchive();
    const statuses = [];
    for (const q of HOSTILE) {
      const { status, body } = await search(q);
      statuses.push([q, status]);
      expect(Array.isArray(body?.archive), `archive missing for ${JSON.stringify(q)}`).toBe(true);
    }
    expect(HOSTILE.length).toBeGreaterThanOrEqual(12);
    for (const [q, status] of statuses) {
      expect(status, `${JSON.stringify(q)} returned ${status}`).toBe(200);
      expect(status < 500, `${JSON.stringify(q)} returned ${status}`).toBe(true);
    }
  });
});

describe('search results', () => {
  it('finds an article by a hyphenated phrase', async () => {
    await seedArchive();
    const { status, body } = await search('cost-benefit');
    expect(status).toBe(200);
    expect(body.archive.map((a) => a.title)).toEqual(['GPT (4) and the cost-benefit of scaling']);
  });

  it('finds an article whose title contains parentheses', async () => {
    await seedArchive();
    const { body } = await search('gpt (4)');
    expect(body.archive).toHaveLength(1);
  });

  it('treats fts5 operators as ordinary words', async () => {
    await seedArchive();
    const { status, body } = await search('AND OR NEAR');
    expect(status).toBe(200);
    expect(body.archive).toHaveLength(1);
  });

  it('returns an empty list, not an error, when nothing matches', async () => {
    await seedArchive();
    const { status, body } = await search('zzzzunmatchable');
    expect(status).toBe(200);
    expect(body.archive).toEqual([]);
  });

  it('falls back to the unfiltered archive when the query is all punctuation', async () => {
    await seedArchive();
    const { status, body } = await search('***');
    expect(status).toBe(200);
    expect(body.archive).toHaveLength(2);
  });

  it('never returns items that are still on Today or Pending', async () => {
    await seedArchive();
    await seedArticle({ title: 'A brand new cost-benefit piece', status: 'new' });
    const { body } = await search('cost-benefit');
    expect(body.archive).toHaveLength(1);
    expect(body.archive[0].status).toBe('kept');
  });

  it('matches notes as well as body text', async () => {
    await seedArticle({
      title: 'Something plain',
      notes: 'the marginalia mentions perovskite',
      status: 'kept',
      resolved_at: new Date().toISOString()
    });
    const { body } = await search('perovskite');
    expect(body.archive).toHaveLength(1);
  });
});

describe('ftsQuery', () => {
  it('quotes every token and prefixes only the last', () => {
    expect(ftsQuery('scaling laws')).toBe('"scaling" "laws"*');
  });

  it('splits on punctuation rather than passing it through', () => {
    expect(ftsQuery('cost-benefit')).toBe('"cost" "benefit"*');
    expect(ftsQuery('gpt (4)')).toBe('"gpt" "4"*');
    expect(ftsQuery('title:x')).toBe('"title" "x"*');
  });

  it('returns null when nothing searchable survives', () => {
    expect(ftsQuery('')).toBeNull();
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery('***')).toBeNull();
    expect(ftsQuery(null)).toBeNull();
    expect(ftsQuery(undefined)).toBeNull();
  });

  it('keeps non-Latin words', () => {
    expect(ftsQuery('日本語')).toBe('"日本語"*');
  });

  it('bounds token length and token count', () => {
    expect(ftsQuery('a'.repeat(200))).toBe(`"${'a'.repeat(64)}"*`);
    expect(ftsQuery('x '.repeat(40)).split(' ')).toHaveLength(16);
  });
});

describe('buildArchiveQuery', () => {
  it('binds the match expression first and paging last', () => {
    const { sql, binds } = buildArchiveQuery({
      columns: 'id, title',
      topicId: 1,
      match: '"a"*',
      limit: 20,
      offset: 40
    });
    expect(sql).toContain('article_fts MATCH ?');
    expect(sql).toContain('ORDER BY rank');
    expect(binds).toEqual(['"a"*', 1, 20, 40]);
  });

  // Phase 3 (V1-15) composes date/source/tag/status/favorite filters on top of
  // exactly this seam, so it is worth a test before those filters exist.
  it('accepts extra clauses and binds without disturbing the search half', async () => {
    await seedArchive();
    const { sql, binds } = buildArchiveQuery({
      columns: 'id, title, favorite',
      topicId: 1,
      match: ftsQuery('cost benefit'),
      clauses: ['a.source = ?'],
      binds: ['example.com']
    });
    const { results } = await import('cloudflare:test').then(({ env }) =>
      env.DB.prepare(sql).bind(...binds).all()
    );
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('cost-benefit');
  });

  it('orders by recency and skips the FTS join when there is no query', () => {
    const { sql, binds } = buildArchiveQuery({ columns: 'id', topicId: 1 });
    expect(sql).not.toContain('article_fts');
    expect(sql).toContain('ORDER BY COALESCE(a.resolved_at, a.added_at) DESC');
    expect(binds).toEqual([1, 200, 0]);
  });
});
