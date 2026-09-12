#!/usr/bin/env node
//
// NeatInfo discovery pipeline.
// Fetches RSS feeds + HN Algolia, deduplicates, scores, and POSTs
// the top candidates to the Worker API.
//
// Runs via: node discover/index.js
// Env vars: NEATINFO_API_URL, NEATINFO_DISCOVER_KEY

import { parseRss } from './rss.js';
import { fetchHN } from './hn.js';
import { normalizeUrl, sourceFromUrl } from './url.js';
import { deduplicate } from './dedup.js';
import { score } from './score.js';

const API_URL = process.env.NEATINFO_API_URL;
const DISCOVER_KEY = process.env.NEATINFO_DISCOVER_KEY;
const BATCH_SIZE = 30;

if (!API_URL || !DISCOVER_KEY) {
  console.error('Missing NEATINFO_API_URL or NEATINFO_DISCOVER_KEY');
  process.exit(1);
}

const FEEDS = [
  // Tier 1: Lab blogs
  { id: 1, name: 'OpenAI Blog',       url: 'https://openai.com/blog/rss.xml',              tier: 1 },
  { id: 2, name: 'Anthropic Blog',    url: 'https://www.anthropic.com/rss.xml',             tier: 1 },
  { id: 3, name: 'Google DeepMind',   url: 'https://deepmind.google/blog/rss.xml',          tier: 1 },
  { id: 4, name: 'Meta AI Blog',      url: 'https://ai.meta.com/blog/rss/',                 tier: 1 },
  // Tier 2: Editorial
  { id: 5, name: 'TechCrunch AI',     url: 'https://techcrunch.com/category/artificial-intelligence/feed/', tier: 2 },
  { id: 6, name: 'The Verge AI',      url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', tier: 2 },
  { id: 7, name: 'MIT Tech Review',   url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/', tier: 2 },
  { id: 8, name: 'Ars Technica',      url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', tier: 2 },
  // Tier 3: Community
  { id: 9, name: 'Hacker News',       url: 'https://hn.algolia.com/api/v1/search',          tier: 3, format: 'api' },
  { id: 10, name: 'arXiv cs.AI',      url: 'https://rss.arxiv.org/rss/cs.AI',               tier: 3 },
];

async function fetchAllFeeds() {
  const items = [];

  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        if (feed.format === 'api') {
          const hnItems = await fetchHN();
          return hnItems.map(item => ({ ...item, feed_source_id: feed.id, tier: feed.tier }));
        }
        const rssItems = await parseRss(feed.url, feed.name);
        return rssItems.map(item => ({ ...item, feed_source_id: feed.id, tier: feed.tier }));
      } catch (err) {
        console.warn(`Failed to fetch ${feed.name}: ${err.message}`);
        return [];
      }
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    }
  }

  console.log(`Fetched ${items.length} raw items from ${FEEDS.length} sources`);
  return items;
}

async function run() {
  const raw = await fetchAllFeeds();

  const normalized = raw
    .map(item => {
      const url = normalizeUrl(item.url);
      if (!url) return null;
      return { ...item, url_normalized: url, source: item.source || sourceFromUrl(url) };
    })
    .filter(Boolean);

  const unique = deduplicate(normalized);
  console.log(`After dedup: ${unique.length} unique items`);

  const scored = unique
    .map(item => ({ ...item, score: score(item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, BATCH_SIZE);

  console.log(`Top ${scored.length} candidates (scores ${scored[0]?.score.toFixed(2)} - ${scored[scored.length - 1]?.score.toFixed(2)})`);

  const batchId = `discover-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;

  const res = await fetch(`${API_URL}/api/candidates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-discover-key': DISCOVER_KEY,
    },
    body: JSON.stringify({ batchId, candidates: scored }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`API error ${res.status}: ${text}`);
    process.exit(1);
  }

  const result = await res.json();
  console.log(`Ingested ${result.inserted} candidates as batch ${result.batchId}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
