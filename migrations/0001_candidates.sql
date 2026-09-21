-- MAR-73: reading candidates. Existing R2 articles are not migrated.
-- source_kind on discoveries is the origin type (manual URL, later feed).
-- Do not store article topics on either table.
CREATE TABLE candidate_articles (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  outlet TEXT NOT NULL,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  fetch_status TEXT NOT NULL,
  listing_state TEXT NOT NULL,
  exclusion_reason TEXT,
  full_text_state TEXT NOT NULL,
  completed_article_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (fetch_status IN ('fetched', 'fetch_failed')),
  CHECK (listing_state IN ('listed', 'excluded')),
  CHECK (full_text_state IN ('confirmed_free', 'unconfirmed', 'unavailable')),
  CHECK (exclusion_reason IS NULL OR exclusion_reason IN ('paywalled')),
  CHECK (completed_article_id IS NULL OR completed_article_id LIKE 'art_%')
);

CREATE INDEX idx_candidate_articles_list
  ON candidate_articles (listing_state, published_at, discovered_at, id);

CREATE TABLE candidate_discoveries (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  discovered_url TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidate_articles(id),
  UNIQUE (candidate_id, source_kind, discovered_url),
  CHECK (length(source_kind) > 0)
);

CREATE INDEX idx_candidate_discoveries_candidate
  ON candidate_discoveries (candidate_id);
