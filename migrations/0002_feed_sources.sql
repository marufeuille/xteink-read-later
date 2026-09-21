-- MAR-74: RSS/Atom information sources. Collection is separate from clip Queue.
-- source_type is the outlet class (corporate blog, posting site, news, curation).
-- Do not store article topics or ranking on this table.
-- candidate_discoveries.source_kind stays an origin label (manual_url or feed:<source id>).
CREATE TABLE feed_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site_url TEXT NOT NULL,
  feed_url TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL,
  topic_tags TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  collection_run_id TEXT,
  collection_status TEXT,
  collection_attempt INTEGER NOT NULL DEFAULT 0,
  collection_error_code TEXT,
  collection_error_message TEXT,
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_registered INTEGER NOT NULL DEFAULT 0,
  items_duplicate INTEGER NOT NULL DEFAULT 0,
  items_skipped INTEGER NOT NULL DEFAULT 0,
  last_collected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_type IN ('corporate_blog', 'posting_site', 'news', 'curation')),
  CHECK (enabled IN (0, 1)),
  CHECK (
    collection_status IS NULL
    OR collection_status IN ('queued', 'running', 'ready', 'failed')
  )
);

CREATE INDEX idx_feed_sources_enabled
  ON feed_sources (enabled, created_at, id);
