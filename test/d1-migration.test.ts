import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('D1 candidate migration', () => {
  it('creates candidate tables without mixing source kind and topic', () => {
    const sql = readFileSync(join(root, 'migrations/0001_candidates.sql'), 'utf8')
    expect(sql).toContain('CREATE TABLE candidate_articles')
    expect(sql).toContain('canonical_url TEXT NOT NULL UNIQUE')
    expect(sql).toContain('published_at TEXT')
    expect(sql).toContain('discovered_at TEXT NOT NULL')
    expect(sql).toContain('completed_article_id TEXT')
    expect(sql).toContain('CREATE TABLE candidate_discoveries')
    expect(sql).toContain('source_kind TEXT NOT NULL')
    expect(sql).not.toMatch(/CREATE TABLE candidate_articles[\s\S]*topic /)
    expect(sql).toContain('Existing R2 articles are not migrated')
  })

  it('adds clip job pointers without a second status machine', () => {
    const sql = readFileSync(join(root, 'migrations/0003_candidate_clip.sql'), 'utf8')
    expect(sql).toContain('ALTER TABLE candidate_articles ADD COLUMN clip_job_id TEXT')
    expect(sql).toContain('ADD COLUMN clip_run_id TEXT')
    expect(sql).toContain('ADD COLUMN selected_at TEXT')
    expect(sql).toContain('Job status')
    expect(sql).toContain('Do not store a second status machine')
    expect(sql).not.toMatch(/ADD COLUMN \w*status/i)
  })

  it('adds recommendation columns without mixing topic classification or a clip job status machine', () => {
    const sql = readFileSync(join(root, 'migrations/0004_candidate_recommend.sql'), 'utf8')
    expect(sql).toContain('ALTER TABLE candidate_articles ADD COLUMN recommend_status')
    expect(sql).toContain('ADD COLUMN recommend_grade')
    expect(sql).toContain('ADD COLUMN recommend_excerpt_hash')
    expect(sql).toContain('ADD COLUMN recommend_version')
    expect(sql).toContain('Separate from article classification')
    expect(sql).toContain('Do not store article body or excerpt text')
    expect(sql).not.toMatch(/ADD COLUMN topic/)
  })

  it('creates feed source tables without mixing outlet type and article topics', () => {
    const sql = readFileSync(join(root, 'migrations/0002_feed_sources.sql'), 'utf8')
    expect(sql).toContain('CREATE TABLE feed_sources')
    expect(sql).toContain('feed_url TEXT NOT NULL UNIQUE')
    expect(sql).toContain("source_type IN ('corporate_blog', 'posting_site', 'news', 'curation')")
    expect(sql).toContain('topic_tags TEXT NOT NULL DEFAULT')
    expect(sql).toContain('enabled INTEGER NOT NULL DEFAULT 1')
    expect(sql).toContain('Collection is separate from clip Queue')
  })

  it('stores digest publication history without article bodies', () => {
    const sql = readFileSync(join(root, 'migrations/0005_daily_digest.sql'), 'utf8')
    expect(sql).toContain('CREATE TABLE digest_published_items')
    expect(sql).toContain('PRIMARY KEY (issue_date, canonical_url)')
    expect(sql).toContain('avoid republishing')
    expect(sql).not.toMatch(/content_html|summary_html|excerpt/)
  })
})
