// Candidate scoring: keyword relevance × position weight + tier bonus + recency.
// No embeddings, no LLM. Simple, fast, tunable.

const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'deep learning',
  'neural network', 'transformer', 'llm', 'large language model',
  'gpt', 'claude', 'gemini', 'llama', 'mistral', 'openai', 'anthropic',
  'deepmind', 'diffusion', 'generative', 'foundation model',
  'fine-tuning', 'rlhf', 'reasoning', 'agent', 'multimodal',
  'computer vision', 'nlp', 'natural language', 'reinforcement learning',
  'embedding', 'rag', 'retrieval', 'benchmark', 'safety', 'alignment',
  'open source', 'inference', 'training', 'gpu', 'parameter',
];

const TIER_BONUS = { 1: 15, 2: 8, 3: 3 };

export function score(item) {
  let s = 0;

  // Keyword relevance (title weighted 3x vs summary)
  const titleLower = (item.title || '').toLowerCase();
  const summaryLower = (item.summary || '').toLowerCase();

  for (const kw of AI_KEYWORDS) {
    if (titleLower.includes(kw)) s += 3;
    if (summaryLower.includes(kw)) s += 1;
  }

  // Source tier bonus
  s += TIER_BONUS[item.tier] || 0;

  // Recency: articles from the last 12 hours get a boost
  if (item.published_at) {
    const age = Date.now() - new Date(item.published_at).getTime();
    const hoursOld = age / (1000 * 60 * 60);
    if (hoursOld < 6) s += 10;
    else if (hoursOld < 12) s += 6;
    else if (hoursOld < 24) s += 3;
    else if (hoursOld < 48) s += 1;
  }

  // HN engagement bonus
  if (item.hn_points) {
    s += Math.min(item.hn_points / 20, 10);
  }

  return Math.round(s * 100) / 100;
}
