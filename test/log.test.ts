import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  logCandidateClip,
  logDailyDigest,
  logOpdsDownload,
  logPipeline,
  logPublishedRepairFailure,
  logSiteRecovery,
} from '../src/log'
import {
  asArticleId,
  asCandidateId,
  asClipJobId,
  asClipRunId,
  type ClipStageRecord,
} from '../src/types'

afterEach(() => {
  vi.restoreAllMocks()
})

function loggedObject(): Record<string, unknown> {
  const value = vi.mocked(console.log).mock.calls.at(-1)?.[0]
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()
  return value as Record<string, unknown>
}

describe('logPipeline', () => {
  it('writes a structured object without book text', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    logPipeline({
      articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      stage: 'epub',
      durationMs: 12,
      errorKind: 'epub_failed',
    })
    const parsed = loggedObject()
    expect(parsed).toEqual({
      message: 'pipeline epub epub_failed',
      event: 'pipeline',
      articleId: 'art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      stage: 'epub',
      durationMs: 12,
      errorKind: 'epub_failed',
    })
    expect(JSON.stringify(parsed)).not.toContain('<p>')
    expect(JSON.stringify(parsed)).not.toContain('chapter')
  })

  it('keeps a stage record on the job context and off the console object', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stages: ClipStageRecord[] = []
    logPipeline(
      { stage: 'fetch', durationMs: 3, errorKind: 'fetch_failed', clipOutcome: 'failed' },
      { jobId: asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), attempt: 2, stages },
    )
    expect(stages).toEqual([{ stage: 'fetch', durationMs: 3, attempt: 2, errorKind: 'fetch_failed' }])
    const parsed = loggedObject()
    expect(parsed).toMatchObject({
      message: 'pipeline fetch failed fetch_failed',
      event: 'pipeline',
      jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      attempt: 2,
      clipOutcome: 'failed',
      errorKind: 'fetch_failed',
    })
    expect(parsed).not.toHaveProperty('stages')
    expect(JSON.stringify(parsed)).not.toContain('https://')
    expect(JSON.stringify(stages)).not.toContain('clipOutcome')
  })

  it('omits undefined optional fields', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    logPipeline({ stage: 'store', durationMs: 1 })
    expect(loggedObject()).toEqual({
      message: 'pipeline store',
      event: 'pipeline',
      stage: 'store',
      durationMs: 1,
    })
  })
})

describe('structured log fields', () => {
  it('keeps the site recovery url off the message', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    logSiteRecovery({
      site: 'medium',
      outcome: 'recovered',
      url: 'https://example.com/secret-path',
    })
    const parsed = loggedObject()
    expect(parsed).toMatchObject({
      message: 'site_recovery recovered',
      event: 'site_recovery',
      outcome: 'recovered',
      url: 'https://example.com/secret-path',
    })
    expect(String(parsed.message)).not.toContain('https://')
    expect(String(parsed.message)).not.toContain('secret-path')
  })

  it('logs digest, opds, clip selection, and repair without article text', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    logDailyDigest({
      date: '2026-09-30',
      status: 'empty',
      selected: 0,
      summarized: 0,
      skipped: 0,
      durationMs: 4,
      qrCount: 0,
    })
    logOpdsDownload({
      articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      durationMs: 8,
    })
    logCandidateClip({
      action: 'select',
      candidateId: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      jobId: asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      runId: asClipRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      selectedAt: '2026-09-21T04:00:00.000Z',
      discoveredAt: '2026-09-21T03:00:00.000Z',
      publishedAt: null,
      reused: false,
      regenerated: false,
    })
    logPublishedRepairFailure(3)
    const calls = vi.mocked(console.log).mock.calls.map((call) => call[0] as Record<string, unknown>)
    expect(calls.map((item) => item.event)).toEqual([
      'daily_digest',
      'opds_download',
      'candidate_clip',
      'published_repair',
    ])
    expect(calls[0]).toMatchObject({ message: 'daily_digest empty', status: 'empty' })
    expect(calls[0]).not.toHaveProperty('articleId')
    expect(calls[1]).toMatchObject({ message: 'opds_download', event: 'opds_download', durationMs: 8 })
    expect(calls[2]).toMatchObject({ message: 'candidate_clip select', action: 'select', publishedAt: null })
    expect(calls[3]).toMatchObject({
      message: 'published_repair repair_failed',
      errorKind: 'repair_failed',
    })
    for (const call of calls) {
      expect(typeof call).toBe('object')
    }
    const text = JSON.stringify(calls)
    expect(text).not.toContain('<p>')
    expect(text).not.toContain('https://')
  })
})

describe('daily workers logs query', () => {
  it('documents the saved queries for the post-cron summary', () => {
    const doc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../docs/workers-logs.md'),
      'utf8',
    )
    expect(doc).toContain(
      '$metadata.service = "xteink-read-later" AND ((event = "pipeline" AND (clipOutcome = "ready" OR clipOutcome = "failed")) OR event = "daily_digest" OR event = "opds_download" OR event = "feed")',
    )
    expect(doc).toContain('$metadata.service = "xteink-read-later" AND $workers.outcome = "exceededCpu"')
    expect(doc).toContain('errorKind')
    expect(doc).toContain('opds_download')
    expect(doc).toContain('payload_too_large')
    expect(doc).toContain('internal_error')
    expect(doc).toContain('feed_schedule')
    expect(doc).toContain('予算スキップのまま残る `unevaluated` は候補ごとに出さない')
  })
})
