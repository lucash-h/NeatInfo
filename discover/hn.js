// Fetch AI-related stories from HackerNews via the Algolia API.
// Free, no key, returns recent stories sorted by relevance.

const QUERIES = ['artificial intelligence', 'LLM', 'machine learning', 'GPT', 'Claude'];
const HN_API = 'https://hn.algolia.com/api/v1/search';

export async function fetchHN() {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  const items = [];
  const seen = new Set();

  const results = await Promise.allSettled(
    QUERIES.map(async (q) => {
      const params = new URLSearchParams({
        query: q,
        tags: 'story',
        numericFilters: `created_at_i>${oneDayAgo}`,
        hitsPerPage: '10',
      });

      const res = await fetch(`${HN_API}?${params}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return [];
      const data = await res.json();
      return data.hits || [];
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const hit of result.value) {
      if (!hit.url || seen.has(hit.objectID)) continue;
      seen.add(hit.objectID);
      items.push({
        title: hit.title,
        url: hit.url,
        summary: '',
        source: 'Hacker News',
        author: hit.author,
        published_at: hit.created_at || null,
        hn_points: hit.points || 0,
        hn_comments: hit.num_comments || 0,
      });
    }
  }

  return items;
}
