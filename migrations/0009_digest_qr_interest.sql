-- MAR-175: weak positive when that issue's QR confirm sends the clip.
-- A published row with no match here is ordinary-or-below, not a dislike.
-- Clip routes outside /digest/send do not write this table.
-- Republishing an issue leaves these rows in place. Joins ignore rows whose
-- candidate is no longer in that issue's digest_published_items.
CREATE TABLE digest_qr_interest (
  issue_date TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (issue_date, candidate_id)
);
