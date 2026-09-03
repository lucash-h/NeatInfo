-- Sample rows so `wrangler dev` shows a populated Today/Pending/Archive.
-- Local development only. Never run this against the real database.

DELETE FROM article_tag;
DELETE FROM event;
DELETE FROM article;
DELETE FROM tag;

INSERT INTO tag (name) VALUES ('papers'), ('infra'), ('product');

INSERT INTO article
  (topic_id, url, url_normalized, title, source, summary, body_text, status, favorite,
   added_at, opened_at, resolved_at, word_count, fetch_status)
VALUES
  (1, 'https://arxiv.org/abs/2609.01234', 'https://arxiv.org/abs/2609.01234',
   'A 14B model matches frontier reasoning on ARC — with nine pages of ablations',
   'arXiv cs.LG',
   'Curriculum distillation from a 400B teacher reaches 61.4% on ARC-AGI-2. The ablation table isolates the gain to two of five stages, and the authors say so.',
   'The headline number is 61.4% on ARC-AGI-2, from a 14B model distilled off a 400B teacher across five curriculum stages.

Two of the five stages account for almost the entire gain. Stages one and four move the score by under a point each, and stage five is negative on two of the four held-out splits.

The evaluation section reports per-split variance across three seeds and includes the failed runs.',
   'new', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, 5060, 'ok'),

  (1, 'https://infoq.example/edge-cold-starts', 'https://infoq.example/edge-cold-starts',
   'Edge inference cold starts, one year of real numbers', 'InfoQ',
   'Median cold start for small models fell from 340ms to 90ms after the isolate change. Per-region percentiles included.',
   'A year of production traces, published with the query set.', 'new', 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, 1840, 'ok'),

  (1, 'https://sundry.dev/read-it-later', 'https://sundry.dev/read-it-later',
   'Why every read-it-later app dies in month three', 'sundry.dev',
   'Argues the failure is queue-shaped interfaces rather than user discipline. No data, but the taxonomy of exits is useful.',
   'The pile is the product failure, not the user.', 'new', 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, 1380, 'ok'),

  (1, 'https://importai.example/tool-calls', 'https://importai.example/tool-calls',
   'The quiet standardization of tool-call interfaces', 'Import AI',
   'Three vendors converged on the same shape within a quarter. Mostly newsletter summary of other people''s announcements.',
   'Convergence without a standards body.', 'new', 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), NULL, 1380, 'ok'),

  (1, 'https://arxiv.org/abs/2608.09876', 'https://arxiv.org/abs/2608.09876',
   'PDF extraction is still the hardest part of any research pipeline', 'arXiv · PDF',
   'Benchmarks six extractors on 2,000 papers. Layout-aware models win on tables and lose on equations.',
   NULL, 'new', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), NULL, NULL, 0, 'non-html'),

  (1, 'https://benchmarks.dev/vector-100k', 'https://benchmarks.dev/vector-100k',
   'Vector search at 100k chunks: a deliberately boring benchmark', 'benchmarks.dev',
   'Recall and p95 latency across three stores at one honest scale, with the query set published.',
   'Boring on purpose.', 'new', 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), NULL, 2070, 'ok'),

  (1, 'https://wattenberg.example/attention-sinks', 'https://wattenberg.example/attention-sinks',
   'Attention sinks, explained without the math', 'wattenberg.blog',
   'The clearest explanation of the first-token phenomenon I have read, with interactive figures.',
   'Interactive figures do the work the equations would.', 'kept', 1,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-13 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-13 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-13 days'), 2530, 'ok'),

  (1, 'https://blog.cloudflare.com/d1-ga', 'https://blog.cloudflare.com/d1-ga',
   'D1 goes GA: the limits that actually matter', 'Cloudflare',
   'Row limits, read replicas, and what the free tier really holds.',
   'The numbers that bind, in one table.', 'kept', 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'), 1610, 'ok'),

  (1, 'https://listicle.example/10-ai-tools', 'https://listicle.example/10-ai-tools',
   '10 AI tools that will change everything in 2026', 'listicle.co',
   'Affiliate links, no claims that can be checked.', NULL, 'dismissed', 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'), NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'), 920, 'ok'),

  (1, 'https://transcripts.example/inference-economics', 'https://transcripts.example/inference-economics',
   'The economics of inference, interviewed', 'Transcript',
   'Long, discursive, two good numbers about margins buried at minute 40.',
   NULL, 'lapsed', 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-21 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), 5980, 'ok');

INSERT INTO article_tag (article_id, tag_id)
SELECT a.id, t.id FROM article a JOIN tag t ON t.name = 'papers'
WHERE a.source LIKE 'arXiv%' OR a.source = 'wattenberg.blog';

INSERT INTO article_tag (article_id, tag_id)
SELECT a.id, t.id FROM article a JOIN tag t ON t.name = 'infra'
WHERE a.source IN ('InfoQ', 'benchmarks.dev', 'Cloudflare', 'Transcript');

INSERT INTO article_tag (article_id, tag_id)
SELECT a.id, t.id FROM article a JOIN tag t ON t.name = 'product'
WHERE a.source IN ('sundry.dev', 'Import AI', 'listicle.co');

INSERT INTO event (article_id, type, created_at) SELECT id, 'added', added_at FROM article;
INSERT INTO event (article_id, type, created_at) SELECT id, 'opened', opened_at FROM article WHERE opened_at IS NOT NULL;
INSERT INTO event (article_id, type, created_at) SELECT id, status, resolved_at FROM article WHERE resolved_at IS NOT NULL AND status IN ('kept','dismissed','lapsed');
INSERT INTO event (article_id, type, created_at) SELECT id, 'starred', resolved_at FROM article WHERE favorite = 1;
