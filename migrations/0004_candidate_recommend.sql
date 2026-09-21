-- MAR-76: data-engineer recommendation judgment. Separate from article classification (MAR-57).
-- Judgment state is not a clip job status machine. Do not store article body or excerpt text.
ALTER TABLE candidate_articles ADD COLUMN recommend_status TEXT NOT NULL DEFAULT 'unevaluated';
ALTER TABLE candidate_articles ADD COLUMN recommend_grade TEXT;
ALTER TABLE candidate_articles ADD COLUMN recommend_decided_grade TEXT;
ALTER TABLE candidate_articles ADD COLUMN recommend_version TEXT;
ALTER TABLE candidate_articles ADD COLUMN recommend_model TEXT;
ALTER TABLE candidate_articles ADD COLUMN recommend_evaluated_at TEXT;
ALTER TABLE candidate_articles ADD COLUMN recommend_excerpt_hash TEXT;
ALTER TABLE candidate_articles ADD COLUMN recommend_confidence REAL;
ALTER TABLE candidate_articles ADD COLUMN recommend_relevant INTEGER;
ALTER TABLE candidate_articles ADD COLUMN recommend_concrete INTEGER;
ALTER TABLE candidate_articles ADD COLUMN recommend_verification INTEGER;
ALTER TABLE candidate_articles ADD COLUMN recommend_error_code TEXT;
ALTER TABLE candidate_articles ADD COLUMN recommend_input_tokens INTEGER;
ALTER TABLE candidate_articles ADD COLUMN recommend_duration_ms INTEGER;
