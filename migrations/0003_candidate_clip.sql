-- MAR-75: pointers from a candidate to a clip job / completed article.
-- Job status (queued/running/ready/failed) stays in R2 jobs/{jobId}.json.
-- Do not store a second status machine in D1.
ALTER TABLE candidate_articles ADD COLUMN clip_job_id TEXT;
ALTER TABLE candidate_articles ADD COLUMN clip_run_id TEXT;
ALTER TABLE candidate_articles ADD COLUMN selected_at TEXT;

CREATE INDEX IF NOT EXISTS idx_candidate_articles_clip_job
  ON candidate_articles (clip_job_id);
