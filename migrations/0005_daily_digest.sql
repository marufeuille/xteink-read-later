-- Daily digest publication history. OPDS identity stays in R2 via date-based canonical URLs.
-- Used only to avoid republishing the same article across past issues.
CREATE TABLE digest_published_items (
  issue_date TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (issue_date, canonical_url)
);

CREATE INDEX digest_published_items_url ON digest_published_items(canonical_url);
