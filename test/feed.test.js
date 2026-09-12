// §2.6: the three surfaces are a query, not a cron job. §9.4: lapse is the one
// exception -- a real transition, written lazily the first time a read notices
// an item aged out.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, resetDb, call, callJson, countEvents, dayStart, isoDaysAgo, seedArticle } from './helpers.js';

beforeAll(applySchema);
beforeEach(resetDb);

const feed = (params = {}) => {
  const qs = new URLSearchParams({ dayStart: dayStart(), ...params });
  return callJson(`/api/feed?${qs}`);
};

const setLapseWindow = (days) =>
  env.DB.prepare(
    `INSERT INTO setting (key, value) VALUES ('lapse_window_days', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(String(days)).run();

describe('surfaces', () => {
  it('puts an item added today in Today and nowhere else', async () => {
    await seedArticle({ title: 'Fresh', added_at: new Date().toISOString() });
    const { body } = await feed();
    expect(body.today.map((a) => a.title)).toEqual(['Fresh']);
    expect(body.pending).toHaveLength(0);
    expect(body.archive).toHaveLength(0);
  });

  it('puts an undecided item from a previous day in Pending', async () => {
    await seedArticle({ title: 'Yesterday', added_at: isoDaysAgo(1) });
    const { body } = await feed();
    expect(body.today).toHaveLength(0);
    expect(body.pending.map((a) => a.title)).toEqual(['Yesterday']);
  });

  it('sorts Today newest-first and Pending oldest-first so the stalest confronts you', async () => {
    await seedArticle({ title: 'today-old', added_at: new Date(Date.now() - 3600000).toISOString() });
    await seedArticle({ title: 'today-new', added_at: new Date().toISOString() });
    await seedArticle({ title: 'pending-3d', added_at: isoDaysAgo(3) });
    await seedArticle({ title: 'pending-1d', added_at: isoDaysAgo(1) });

    const { body } = await feed();
    expect(body.today.map((a) => a.title)).toEqual(['today-new', 'today-old']);
    expect(body.pending.map((a) => a.title)).toEqual(['pending-3d', 'pending-1d']);
  });

  it('puts anything resolved in Archive, never on an active surface', async () => {
    await seedArticle({ title: 'Kept', status: 'kept', resolved_at: isoDaysAgo(1), added_at: isoDaysAgo(2) });
    await seedArticle({ title: 'Dismissed', status: 'dismissed', resolved_at: isoDaysAgo(1), added_at: isoDaysAgo(2) });
    const { body } = await feed();
    expect(body.today).toHaveLength(0);
    expect(body.pending).toHaveLength(0);
    expect(body.archive.map((a) => a.title).sort()).toEqual(['Dismissed', 'Kept']);
    expect(body.archiveTotal).toBe(2);
  });

  it('attaches tags to the rows it returns', async () => {
    const { id } = await seedArticle({ title: 'Tagged' });
    await call(`/api/articles/${id}`, { method: 'PATCH', body: JSON.stringify({ tags: ['Papers', 'llm'] }) });
    const { body } = await feed();
    expect(body.today[0].tags.sort()).toEqual(['llm', 'papers']);
  });

  it('returns favorite as a boolean, not SQLite\'s 0/1', async () => {
    await seedArticle({ title: 'Starred', favorite: 1 });
    const { body } = await feed();
    expect(body.today[0].favorite).toBe(true);
  });
});

// "Opened but undecided" is a filter on Pending, not a fourth surface. §2.3
describe('the Pending opened/unopened filter', () => {
  const seedBoth = async () => {
    await seedArticle({ title: 'opened', added_at: isoDaysAgo(2), opened_at: isoDaysAgo(1) });
    await seedArticle({ title: 'never opened', added_at: isoDaysAgo(2) });
  };

  it('returns both under the default filter', async () => {
    await seedBoth();
    const { body } = await feed();
    expect(body.pending).toHaveLength(2);
    expect(body.pendingTotal).toBe(2);
  });

  it('partitions on filter=opened', async () => {
    await seedBoth();
    const { body } = await feed({ filter: 'opened' });
    expect(body.pending.map((a) => a.title)).toEqual(['opened']);
  });

  it('partitions on filter=unopened', async () => {
    await seedBoth();
    const { body } = await feed({ filter: 'unopened' });
    expect(body.pending.map((a) => a.title)).toEqual(['never opened']);
  });

  it('leaves pendingTotal unfiltered so the surface count stays honest', async () => {
    await seedBoth();
    const { body } = await feed({ filter: 'opened' });
    expect(body.pending).toHaveLength(1);
    expect(body.pendingTotal).toBe(2);
  });
});

// §2.4 -- the automatic exit that stops Pending becoming the new guilt pile.
describe('lapse', () => {
  it('leaves an item at N-1 days in Pending', async () => {
    const { id } = await seedArticle({ title: 'nearly', added_at: isoDaysAgo(13) });
    const { body } = await feed();
    expect(body.pending.map((a) => a.title)).toEqual(['nearly']);
    expect(await countEvents(id, 'lapsed')).toBe(0);
  });

  it('archives an item at N+1 days as lapsed', async () => {
    const { id } = await seedArticle({ title: 'aged out', added_at: isoDaysAgo(15) });
    const { body } = await feed();
    expect(body.pending).toHaveLength(0);
    expect(body.archive).toHaveLength(1);
    expect(body.archive[0].status).toBe('lapsed');
    expect(body.archive[0].resolved_at).toBeTruthy();
    expect(await countEvents(id, 'lapsed')).toBe(1);
  });

  it('writes exactly one lapsed event, and a second read is a no-op', async () => {
    const { id } = await seedArticle({ added_at: isoDaysAgo(20) });
    await feed();
    const after = await env.DB.prepare(`SELECT resolved_at FROM article WHERE id = ?1`).bind(id).first();
    await feed();
    await feed();
    expect(await countEvents(id, 'lapsed')).toBe(1);
    const later = await env.DB.prepare(`SELECT resolved_at FROM article WHERE id = ?1`).bind(id).first();
    expect(later.resolved_at).toBe(after.resolved_at);
  });

  it('never lapses something already resolved', async () => {
    const { id } = await seedArticle({ status: 'kept', added_at: isoDaysAgo(30), resolved_at: isoDaysAgo(29) });
    await feed();
    expect(await countEvents(id, 'lapsed')).toBe(0);
    const row = await env.DB.prepare(`SELECT status FROM article WHERE id = ?1`).bind(id).first();
    expect(row.status).toBe('kept');
  });

  it('honours a configured window rather than the hardcoded 14', async () => {
    await setLapseWindow(3);
    const { id } = await seedArticle({ added_at: isoDaysAgo(5) });
    const { body } = await feed();
    expect(body.lapseWindowDays).toBe(3);
    expect(body.archive[0].id).toBe(id);
    expect(await countEvents(id, 'lapsed')).toBe(1);
  });

  // V1-27: the batch is two statements per lapsed row and the row set is
  // whatever aged out since the last read -- after a month away, or after
  // restoring an old export, that is not five rows. It is chunked at 50 rows
  // (100 statements) and the loop carries the rest. G14 called this "works,
  // untested"; these are the boundary.
  async function seedLapsable(n) {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      const { id } = await seedArticle({ title: `aged ${i}`, added_at: isoDaysAgo(20 + i) });
      ids.push(id);
    }
    return ids;
  }

  it('lapses a batch that is exactly one chunk', async () => {
    const ids = await seedLapsable(50);
    const { body } = await feed({ limit: '200' });
    expect(body.pending).toHaveLength(0);
    expect(body.archiveTotal).toBe(50);
    for (const id of ids) expect(await countEvents(id, 'lapsed')).toBe(1);
  });

  it('lapses a batch one row past a chunk, which is where an uncapped batch would have been the only path', async () => {
    const ids = await seedLapsable(51);
    const { body } = await feed({ limit: '200' });
    expect(body.pending).toHaveLength(0);
    expect(body.archiveTotal).toBe(51);
    const events = await env.DB.prepare(`SELECT COUNT(*) AS n FROM event WHERE type = 'lapsed'`).first();
    expect(events.n).toBe(51);
    for (const id of ids) expect(await countEvents(id, 'lapsed')).toBe(1);
  });

  it('lapses several chunks in one read and still writes exactly one event each', async () => {
    await seedLapsable(120);
    const { body } = await feed({ limit: '200' });
    expect(body.archiveTotal).toBe(120);
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM article WHERE status = 'lapsed' AND resolved_at IS NOT NULL`
    ).first();
    expect(rows.n).toBe(120);
    const events = await env.DB.prepare(`SELECT COUNT(*) AS n FROM event WHERE type = 'lapsed'`).first();
    expect(events.n).toBe(120);

    // And the second read is still a no-op, however many chunks the first took.
    await feed();
    const again = await env.DB.prepare(`SELECT COUNT(*) AS n FROM event WHERE type = 'lapsed'`).first();
    expect(again.n).toBe(120);
  });

  it('lapses on any read, so no cron job is needed', async () => {
    const { id } = await seedArticle({ added_at: isoDaysAgo(15) });
    const before = await env.DB.prepare(`SELECT status FROM article WHERE id = ?1`).bind(id).first();
    expect(before.status).toBe('new');
    await feed();
    const after = await env.DB.prepare(`SELECT status FROM article WHERE id = ?1`).bind(id).first();
    expect(after.status).toBe('lapsed');
  });
});

// §2.5 -- the terminal actions, and the events v2 cannot reconstruct later. §4
describe('transitions', () => {
  it('Keep moves an item to Archive and records the event', async () => {
    const { id } = await seedArticle();
    const { status, body } = await callJson(`/api/articles/${id}/resolve`, {
      method: 'POST', body: JSON.stringify({ status: 'kept' })
    });
    expect(status).toBe(200);
    expect(body.article.status).toBe('kept');
    expect(await countEvents(id, 'kept')).toBe(1);

    const { body: after } = await feed();
    expect(after.today).toHaveLength(0);
    expect(after.archive.map((a) => a.id)).toEqual([id]);
  });

  it('Star resolves as kept and favorite, writing both events', async () => {
    const { id } = await seedArticle();
    const { body } = await callJson(`/api/articles/${id}/resolve`, {
      method: 'POST', body: JSON.stringify({ status: 'kept', favorite: true })
    });
    expect(body.article.favorite).toBe(true);
    expect(await countEvents(id, 'kept')).toBe(1);
    expect(await countEvents(id, 'starred')).toBe(1);
  });

  it('Dismiss archives without favoriting', async () => {
    const { id } = await seedArticle();
    const { body } = await callJson(`/api/articles/${id}/resolve`, {
      method: 'POST', body: JSON.stringify({ status: 'dismissed', favorite: true })
    });
    expect(body.article.status).toBe('dismissed');
    expect(body.article.favorite).toBe(false);
    expect(await countEvents(id, 'dismissed')).toBe(1);
  });

  it('starring and unstarring an archived item records both directions', async () => {
    const { id } = await seedArticle({ status: 'kept', resolved_at: isoDaysAgo(1) });
    await call(`/api/articles/${id}/star`, { method: 'POST', body: JSON.stringify({ favorite: true }) });
    const { body } = await callJson(`/api/articles/${id}/star`, {
      method: 'POST', body: JSON.stringify({ favorite: false })
    });
    expect(body.article.favorite).toBe(false);
    expect(await countEvents(id, 'starred')).toBe(1);
    expect(await countEvents(id, 'unstarred')).toBe(1);
  });

  // One nullable timestamp set on a real click -- no impression tracking. §2.3
  it('opening stamps opened_at once and keeps the first timestamp', async () => {
    const { id } = await seedArticle();
    const first = await callJson(`/api/articles/${id}/open`, { method: 'POST', body: '{}' });
    expect(first.body.article.opened_at).toBeTruthy();
    const second = await callJson(`/api/articles/${id}/open`, { method: 'POST', body: '{}' });
    expect(second.body.article.opened_at).toBe(first.body.article.opened_at);
  });

  it('listening stamps listened_at separately from opened_at', async () => {
    const { id } = await seedArticle();
    const { body } = await callJson(`/api/articles/${id}/listen`, { method: 'POST', body: '{}' });
    expect(body.article.listened_at).toBeTruthy();
    expect(body.article.opened_at).toBeNull();
    expect(await countEvents(id, 'listened')).toBe(1);
  });

  it('saves a note and normalizes tags to lowercase without duplicates', async () => {
    const { id } = await seedArticle();
    const { body } = await callJson(`/api/articles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'worth rereading', tags: ['LLM', 'llm', ' Papers '] })
    });
    expect(body.article.notes).toBe('worth rereading');
    expect(body.article.tags.sort()).toEqual(['llm', 'papers']);
  });

  it('makes a saved note searchable through the FTS triggers', async () => {
    const { id } = await seedArticle({ status: 'kept', resolved_at: isoDaysAgo(1) });
    await call(`/api/articles/${id}`, { method: 'PATCH', body: JSON.stringify({ notes: 'ferroelectric' }) });
    const { body } = await feed({ q: 'ferroelectric' });
    expect(body.archive.map((a) => a.id)).toEqual([id]);
  });
});
