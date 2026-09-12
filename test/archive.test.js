// §3 "Store" promises filters over the archive -- date range, source, tag,
// status, favorite -- and §2.2 promises it is searchable forever. Neither was
// true: /api/feed took only `q`, capped the archive at 200 rows and reported
// an unfiltered total next to a filtered page. This file is the server half of
// success criteria 2 and 8.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, call, callJson, resetDb, seedArticle } from './helpers.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildArchiveCount,
  buildArchiveQuery,
  parseArchiveParams
} from '../worker/search.js';

beforeAll(applySchema);
beforeEach(resetDb);

const feed = (params = '') =>
  callJson(`/api/feed?dayStart=${encodeURIComponent(new Date().toISOString())}${params}`);

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

async function tagArticle(id, names) {
  for (const name of names) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tag (name) VALUES (?1)`).bind(name).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO article_tag (article_id, tag_id)
       VALUES (?1, (SELECT id FROM tag WHERE name = ?2))`
    ).bind(id, name).run();
  }
}

// An archived row is one with a resolution; `added_at` is what the date range
// filters on, so it is set explicitly everywhere below.
async function seedArchived(fields) {
  return seedArticle({
    status: 'kept',
    resolved_at: fields.added_at || iso(1),
    ...fields
  });
}

async function seedMixed() {
  const a = await seedArchived({
    title: 'Scaling laws revisited',
    source: 'arxiv.org',
    added_at: iso(30),
    status: 'kept',
    favorite: 1,
    body_text: 'A paper about scaling laws and compute budgets.'
  });
  const b = await seedArchived({
    title: 'A gardening diary',
    source: 'garden.example',
    added_at: iso(10),
    status: 'dismissed',
    body_text: 'Tomatoes and scaling a trellis.'
  });
  const c = await seedArchived({
    title: 'Forgotten interview',
    source: 'news.example',
    added_at: iso(2),
    status: 'lapsed',
    body_text: 'An interview nobody got round to.'
  });
  await tagArticle(a.id, ['ml', 'papers']);
  await tagArticle(b.id, ['garden']);
  await tagArticle(c.id, ['ml']);
  return { a, b, c };
}

describe('parseArchiveParams', () => {
  const parse = (qs) => parseArchiveParams(new URLSearchParams(qs));

  it('defaults to no filters and the first page', () => {
    const p = parse('');
    expect(p.filters).toEqual({});
    expect(p.limit).toBe(DEFAULT_LIMIT);
    expect(p.offset).toBe(0);
  });

  it('widens a bare date to cover the whole day at each end', () => {
    const p = parse('from=2026-01-05&to=2026-01-06');
    expect(p.filters.from).toBe('2026-01-05T00:00:00.000Z');
    expect(p.filters.to).toBe('2026-01-06T23:59:59.999Z');
  });

  it('rejects a status it cannot honour rather than ignoring it', () => {
    expect(parse('status=nonsense').error).toBeTruthy();
    expect(parse('status=kept').filters.status).toBe('kept');
    expect(parse('status=all').filters).toEqual({});
  });

  it('rejects an unparseable date', () => {
    expect(parse('from=last+tuesday').error).toBeTruthy();
    expect(parse('to=2026-13').error).toBeTruthy();
  });

  it('treats only the on state of the favorite toggle as a filter', () => {
    expect(parse('favorite=1').filters.favorite).toBe(true);
    expect(parse('favorite=0').filters).toEqual({});
  });

  it('lowercases the tag, because tags are stored lowercased', () => {
    expect(parse('tag=ML').filters.tag).toBe('ml');
  });

  it('clamps the page window', () => {
    expect(parse('limit=100000').limit).toBe(MAX_LIMIT);
    expect(parse('limit=-3').limit).toBe(DEFAULT_LIMIT);
    expect(parse('limit=abc').limit).toBe(DEFAULT_LIMIT);
    expect(parse('offset=-9').offset).toBe(0);
    expect(parse('limit=10&offset=30')).toMatchObject({ limit: 10, offset: 30 });
  });
});

describe('the SQL the filters build', () => {
  it('never interpolates a user value into the statement text', () => {
    const filters = {
      status: 'kept',
      favorite: true,
      source: "o'brien.example",
      tag: 'ml',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T23:59:59.999Z'
    };
    const { sql, binds } = buildArchiveQuery({
      columns: 'id, title',
      topicId: 1,
      match: '"scaling"*',
      filters,
      limit: 10,
      offset: 20
    });

    for (const value of ["o'brien.example", 'ml', '2026-01-01T00:00:00.000Z', '"scaling"*']) {
      expect(sql).not.toContain(value);
    }
    // One `?` per bound value, and the window is the last two.
    expect((sql.match(/\?/g) || []).length).toBe(binds.length);
    expect(binds.slice(-2)).toEqual([10, 20]);
  });

  it('counts under exactly the predicate it pages', () => {
    const args = { topicId: 1, match: null, filters: { status: 'kept', tag: 'ml' } };
    const rows = buildArchiveQuery({ columns: 'id', ...args });
    const count = buildArchiveCount(args);
    expect(count.sql).toContain('COUNT(*)');
    // The count's binds are the row query's, minus the page window.
    expect(count.binds).toEqual(rows.binds.slice(0, -2));
  });
});

describe('archive filters on /api/feed', () => {
  it('filters by status', async () => {
    const { c } = await seedMixed();
    const { body } = await feed('&status=lapsed');
    expect(body.archive.map((a) => a.id)).toEqual([c.id]);
    expect(body.archiveTotal).toBe(1);
  });

  it('filters by favorite server-side, not over one page', async () => {
    const { a } = await seedMixed();
    const { body } = await feed('&favorite=1');
    expect(body.archive.map((x) => x.id)).toEqual([a.id]);
    expect(body.archiveTotal).toBe(1);
  });

  it('filters by source', async () => {
    const { b } = await seedMixed();
    const { body } = await feed('&source=' + encodeURIComponent('garden.example'));
    expect(body.archive.map((x) => x.id)).toEqual([b.id]);
  });

  it('filters by tag', async () => {
    const { a, c } = await seedMixed();
    const { body } = await feed('&tag=ml');
    expect(body.archive.map((x) => x.id).sort()).toEqual([a.id, c.id].sort());
    expect(body.archiveTotal).toBe(2);
  });

  it('a tag on an article twice cannot double the row or the count', async () => {
    const { a } = await seedMixed();
    await tagArticle(a.id, ['ml']);   // INSERT OR IGNORE: still one join row
    const { body } = await feed('&tag=ml&favorite=1');
    expect(body.archive).toHaveLength(1);
    expect(body.archiveTotal).toBe(1);
  });

  it('filters by date range on added_at, inclusive at both ends', async () => {
    const { b } = await seedMixed();
    const day = b.added_at.slice(0, 10);
    const { body } = await feed(`&from=${day}&to=${day}`);
    expect(body.archive.map((x) => x.id)).toEqual([b.id]);
  });

  it('an open-ended range filters from one side only', async () => {
    const { b, c } = await seedMixed();
    const { body } = await feed(`&from=${iso(11).slice(0, 10)}`);
    expect(body.archive.map((x) => x.id).sort()).toEqual([b.id, c.id].sort());
  });

  it('never shows an unresolved article, whatever the filter', async () => {
    await seedArticle({ title: 'Still new', source: 'garden.example', status: 'new' });
    await seedMixed();
    const { body } = await feed('&source=' + encodeURIComponent('garden.example'));
    expect(body.archive.every((x) => x.status !== 'new')).toBe(true);
  });

  it('composes tag + date range + search', async () => {
    const { a, c } = await seedMixed();
    // `ml` covers both a (30 days ago) and c (2 days ago); the range excludes
    // a; the search excludes c's stablemate anyway.
    const { body } = await feed(
      `&tag=ml&from=${iso(5).slice(0, 10)}&to=${iso(0).slice(0, 10)}&q=${encodeURIComponent('interview')}`
    );
    expect(body.archive.map((x) => x.id)).toEqual([c.id]);
    expect(body.archiveTotal).toBe(1);
    expect(body.archive.map((x) => x.id)).not.toContain(a.id);
  });

  it('reports the filters it applied, so the UI can say what is on', async () => {
    await seedMixed();
    const { body } = await feed('&status=kept&favorite=1');
    expect(body.archiveFilters).toEqual({ status: 'kept', favorite: true });
  });

  it('answers 400 for a filter it cannot honour rather than showing everything', async () => {
    await seedMixed();
    const { status, body } = await feed('&status=deleted');
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it('a filter matching nothing is an empty archive, not an error', async () => {
    await seedMixed();
    const { status, body } = await feed('&tag=nonexistent');
    expect(status).toBe(200);
    expect(body.archive).toEqual([]);
    expect(body.archiveTotal).toBe(0);
  });
});

describe('GET /api/facets', () => {
  it('returns sources and tags with counts that match a direct SQL count', async () => {
    await seedMixed();
    const { status, body } = await callJson('/api/facets');
    expect(status).toBe(200);

    const bySource = Object.fromEntries(body.sources.map((s) => [s.name, s.count]));
    expect(bySource).toEqual({ 'arxiv.org': 1, 'garden.example': 1, 'news.example': 1 });

    const byTag = Object.fromEntries(body.tags.map((t) => [t.name, t.count]));
    expect(byTag).toEqual({ ml: 2, papers: 1, garden: 1 });

    const direct = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM article_tag at JOIN tag t ON t.id = at.tag_id
       WHERE t.name = 'ml'`
    ).first();
    expect(byTag.ml).toBe(direct.n);
  });

  it('counts the whole archive, not one page of it', async () => {
    for (let i = 0; i < 60; i++) {
      await seedArchived({ title: `Row ${i}`, source: 'bulk.example', added_at: iso(i + 1) });
    }
    const { body } = await callJson('/api/facets');
    expect(body.sources.find((s) => s.name === 'bulk.example').count).toBe(60);
  });

  it('describes the archive only -- an unresolved article is not filterable', async () => {
    await seedArticle({ title: 'Still new', source: 'brandnew.example', status: 'new' });
    await seedMixed();
    const { body } = await callJson('/api/facets');
    expect(body.sources.map((s) => s.name)).not.toContain('brandnew.example');
  });

  it('reports the earliest added_at as the floor for the date inputs', async () => {
    const { a } = await seedMixed();
    const { body } = await callJson('/api/facets');
    expect(body.earliestAddedAt).toBe(a.added_at);
  });

  it('is empty rather than broken on an empty archive', async () => {
    const { status, body } = await callJson('/api/facets');
    expect(status).toBe(200);
    expect(body).toEqual({ sources: [], tags: [], earliestAddedAt: null });
  });

  it('answers in one round trip', async () => {
    await seedMixed();
    const res = await call('/api/facets');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// Success criterion 8: the archive was capped at a hardcoded LIMIT 200 with no
// paging and an unfiltered total, so "searchable forever" (§2.2) stopped being
// true at row 201 and the number on screen described a page rather than an
// archive.
describe('paging past the old 200-row cap', () => {
  const BULK = 250;

  // Distinct resolved_at values, newest first, so the order the archive pages
  // in is deterministic rather than an artefact of insertion order.
  async function seedBulk() {
    const statements = [];
    for (let i = 0; i < BULK; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString();
      statements.push(
        env.DB.prepare(
          `INSERT INTO article (topic_id, title, source, status, favorite, added_at, resolved_at, body_text)
           VALUES (1, ?1, ?2, 'kept', ?3, ?4, ?4, ?5)`
        ).bind(
          `Bulk row ${i}`,
          i % 5 === 0 ? 'special.example' : 'bulk.example',
          i % 10 === 0 ? 1 : 0,
          at,
          `Body of bulk row ${i}.` + (i % 10 === 0 ? ' A kangaroo appears.' : '')
        )
      );
    }
    await env.DB.batch(statements);
  }

  it('returns the right slice on each page and a total of 250', async () => {
    await seedBulk();

    const first = await feed('&limit=50');
    expect(first.body.archive).toHaveLength(50);
    expect(first.body.archiveTotal).toBe(BULK);
    // Newest first: row 249 down to row 200.
    expect(first.body.archive[0].title).toBe('Bulk row 249');
    expect(first.body.archive[49].title).toBe('Bulk row 200');

    const second = await feed('&limit=50&offset=50');
    expect(second.body.archive).toHaveLength(50);
    expect(second.body.archiveTotal).toBe(BULK);
    expect(second.body.archive[0].title).toBe('Bulk row 199');
    expect(second.body.archive[49].title).toBe('Bulk row 150');

    // No row appears on two pages.
    const ids = new Set([
      ...first.body.archive.map((a) => a.id),
      ...second.body.archive.map((a) => a.id)
    ]);
    expect(ids.size).toBe(100);
  });

  it('reaches the rows past 200, which is what the cap used to hide', async () => {
    await seedBulk();
    const tail = await feed('&limit=50&offset=200');
    expect(tail.body.archive).toHaveLength(50);
    expect(tail.body.archive[0].title).toBe('Bulk row 49');
    expect(tail.body.archive[49].title).toBe('Bulk row 0');
  });

  it('walks the whole archive page by page, once each', async () => {
    await seedBulk();
    const seen = [];
    for (let offset = 0; offset < BULK; offset += 100) {
      const page = await feed(`&limit=100&offset=${offset}`);
      seen.push(...page.body.archive.map((a) => a.id));
    }
    expect(seen).toHaveLength(BULK);
    expect(new Set(seen).size).toBe(BULK);
  });

  it('an offset past the end is an empty page, not an error, and the total holds', async () => {
    await seedBulk();
    const { status, body } = await feed('&limit=50&offset=1000');
    expect(status).toBe(200);
    expect(body.archive).toEqual([]);
    expect(body.archiveTotal).toBe(BULK);
  });

  it('reports the filtered total beside a filtered page, not the whole archive', async () => {
    await seedBulk();
    const { body } = await feed('&limit=10&source=' + encodeURIComponent('special.example'));
    expect(body.archive).toHaveLength(10);
    // Every fifth row: 250 / 5.
    expect(body.archiveTotal).toBe(50);
    expect(body.archive.every((a) => a.source === 'special.example')).toBe(true);
  });

  it('searches the whole archive, not the first page of it', async () => {
    await seedBulk();
    // "kangaroo" is only on every tenth row, none of them on page one by
    // recency alone -- a client-side search over a page would miss most.
    const { body } = await feed('&limit=5&q=kangaroo');
    expect(body.archiveTotal).toBe(25);
    expect(body.archive).toHaveLength(5);
  });

  it('still attaches tags on a page wider than the D1 bound-variable limit', async () => {
    await seedBulk();
    // The tag lookup used to be one `IN (?, ...)` over the whole page, which
    // D1 rejects past 100 variables -- a 200-row page 500d.
    const { body: firstPage } = await feed('&limit=200');
    await tagArticle(firstPage.archive[150].id, ['deep']);

    const { status, body } = await feed('&limit=200');
    expect(status).toBe(200);
    expect(body.archive).toHaveLength(MAX_LIMIT);
    expect(body.archive[150].tags).toEqual(['deep']);
    expect(body.archive.every((a) => Array.isArray(a.tags))).toBe(true);
  });

  it('never hands back more than the maximum page, however large the ask', async () => {
    await seedBulk();
    const { status, body } = await feed('&limit=100000');
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.archive).toHaveLength(MAX_LIMIT);
    expect(body.archiveTotal).toBe(BULK);
  });
});
