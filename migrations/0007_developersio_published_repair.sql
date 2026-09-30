-- MAR-128: one-shot markers for re-fetching DevelopersIO article published dates.
-- Candidate rows are left as they are. The worker re-fetches dev.classmethod.jp pages once.
-- Removing these marker rows makes that re-fetch run again. Other sites are not selected.
CREATE TABLE data_repairs (
  id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);

CREATE TABLE candidate_published_repairs (
  candidate_id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidate_articles(id)
);
