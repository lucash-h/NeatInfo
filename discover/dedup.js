// Deduplication by normalized URL, then by title similarity.
// Two articles from different outlets covering the same story
// are caught by trigram Jaccard similarity on their titles.

const SIMILARITY_THRESHOLD = 0.45;

export function deduplicate(items) {
  const byUrl = new Map();

  // First pass: exact URL dedup (keep highest-tier source)
  for (const item of items) {
    const key = item.url_normalized;
    const existing = byUrl.get(key);
    if (!existing || item.tier < existing.tier) {
      byUrl.set(key, item);
    }
  }

  const unique = [...byUrl.values()];

  // Second pass: title similarity dedup
  const kept = [];
  for (const item of unique) {
    const isDup = kept.some(k => titleSimilarity(k.title, item.title) > SIMILARITY_THRESHOLD);
    if (!isDup) {
      kept.push(item);
    }
  }

  return kept;
}

function trigrams(text) {
  const lower = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = lower.split(/\s+/).filter(Boolean);
  const grams = new Set();
  for (const word of words) {
    for (let i = 0; i <= word.length - 3; i++) {
      grams.add(word.slice(i, i + 3));
    }
  }
  return grams;
}

function titleSimilarity(a, b) {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection++;
  }

  return intersection / (setA.size + setB.size - intersection);
}
