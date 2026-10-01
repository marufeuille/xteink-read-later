-- MAR-159: stop two feeds that stay over the 3_000_000 byte cap.
-- Measured 2026-10-01:
--   PostHog (src_8663f0e76ff0ccbf610becf192f0245f) https://posthog.com/rss.xml = 3385152 bytes.
--     /blog/rss.xml redirects there. No category or changelog feed.
--   Deep Learning Focus (src_5d791aaaf3243c522554564dff7c15a0)
--     https://cameronrwolfe.substack.com/feed = 5558192 bytes.
--     ?limit=5 returns the same body. No summary-only official feed.
-- enabled = 0 is the sources-screen stop flag. Rows and feed URLs stay.
-- Re-enable from the sources screen if a smaller official feed appears.
-- Do not raise the feed payload cap in this migration.
UPDATE feed_sources
SET enabled = 0,
    updated_at = '2026-10-01T15:00:00.000Z'
WHERE id = 'src_8663f0e76ff0ccbf610becf192f0245f'
  AND feed_url = 'https://posthog.com/rss.xml';

UPDATE feed_sources
SET enabled = 0,
    updated_at = '2026-10-01T15:00:00.000Z'
WHERE id = 'src_5d791aaaf3243c522554564dff7c15a0'
  AND feed_url = 'https://cameronrwolfe.substack.com/feed';
