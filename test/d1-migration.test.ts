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
})
