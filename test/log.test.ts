import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  feedCollectionErrorLog,
  feedLogHostname,
  logCandidateClip,
  logDailyDigest,
  logFeed,
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

describe('feed payload_too_large size log', () => {
  it('logs only a numeric byte count and drops url, body, and exception text', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const secretUrl = 'https://oversized.example/feed.xml?token=super-secret-token'
    const exceptionText = 'Payload exceeded the size limit (3385152 bytes) token=super-secret-token'
    const entry = {
      stage: 'collect' as const,
      durationMs: 9,
      errorKind: 'payload_too_large',
      bytes: 3_385_152,
      sourceId: 'src_8663f0e76ff0ccbf610becf192f0245f',
      url: secretUrl,
      reason: exceptionText,
      body: '<rss>raw body token=super-secret-token</rss>',
      message: exceptionText,
    }
    logFeed(entry)
    const parsed = loggedObject()
    expect(parsed).toEqual({
      message: 'feed collect payload_too_large',
      event: 'feed',
      stage: 'collect',
      durationMs: 9,
      errorKind: 'payload_too_large',
      sourceId: 'src_8663f0e76ff0ccbf610becf192f0245f',
      bytes: 3_385_152,
    })
    expect(typeof parsed.bytes).toBe('number')
    expect(parsed).not.toHaveProperty('url')
    expect(parsed).not.toHaveProperty('reason')
    expect(parsed).not.toHaveProperty('body')
    const text = JSON.stringify(parsed)
    expect(text).not.toContain('https://')
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('raw body')
    expect(text).not.toContain('Payload exceeded')
    expect(String(parsed.message)).not.toContain('3385152')
  })

  it('omits bytes unless the failure is payload_too_large and the size is finite', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(feedCollectionErrorLog({ kind: 'payload_too_large', bytes: 5_558_192 })).toEqual({
      errorKind: 'payload_too_large',
      bytes: 5_558_192,
    })
    expect(feedCollectionErrorLog({ kind: 'payload_too_large', bytes: '5558192' })).toEqual({
      errorKind: 'payload_too_large',
    })
    expect(feedCollectionErrorLog({ kind: 'payload_too_large', bytes: Number.NaN })).toEqual({
      errorKind: 'payload_too_large',
    })
    expect(feedCollectionErrorLog({ kind: 'fetch_failed', bytes: 12 })).toEqual({
      errorKind: 'fetch_failed',
    })
    logFeed({
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      bytes: 12,
    })
    logFeed({
      stage: 'collect',
      durationMs: 2,
      errorKind: 'payload_too_large',
      bytes: Number.POSITIVE_INFINITY,
    })
    const calls = vi.mocked(console.log).mock.calls.map((call) => call[0] as Record<string, unknown>)
    expect(calls[0]).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
    })
    expect(calls[1]).toEqual({
      message: 'feed collect payload_too_large',
      event: 'feed',
      stage: 'collect',
      durationMs: 2,
      errorKind: 'payload_too_large',
    })
    expect(calls[0]).not.toHaveProperty('bytes')
    expect(calls[1]).not.toHaveProperty('bytes')
  })
})

describe('feed hostname log', () => {
  it('keeps a searchable hostname and drops path, query, url, and secrets', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const feedUrl = 'https://user:secret-token@News.Example.com:8443/rss/private-path.xml?token=query-secret#frag'
    expect(feedLogHostname(feedUrl)).toBe('news.example.com')
    expect(feedLogHostname('https://[2001:db8::1]/feed?x=1')).toBe('[2001:db8::1]')
    expect(feedLogHostname('https://例え.jp/path?q=1')).toBe('xn--r8jz45g.jp')
    expect(feedLogHostname('not a url')).toBeUndefined()

    logFeed({
      stage: 'collect',
      durationMs: 4,
      errorKind: 'fetch_failed',
      sourceId: 'src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hostname: 'localhost',
    })
    logFeed({
      stage: 'collect',
      durationMs: 5,
      errorKind: 'fetch_failed',
      hostname: feedUrl,
    })
    const calls = vi.mocked(console.log).mock.calls.map((call) => call[0] as Record<string, unknown>)
    expect(calls[0]).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 4,
      errorKind: 'fetch_failed',
      sourceId: 'src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hostname: 'localhost',
    })
    expect(String(calls[0]?.message)).toMatch(/^[A-Za-z0-9_ ]+$/)
    expect(String(calls[0]?.message)).not.toContain('localhost')
    expect(calls[1]).not.toHaveProperty('hostname')
    expect(calls[1]).not.toHaveProperty('body')
    expect(feedLogHostname('https://example.com./rss/private-path.xml?token=query-secret')).toBe('example.com')
    const text = JSON.stringify(calls)
    expect(text).not.toContain('https://')
    expect(text).not.toContain('private-path')
    expect(text).not.toContain('query-secret')
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('8443')
    expect(text).not.toContain('raw body')
    expect(text).not.toContain('/rss/')
  })
})

describe('feed fetch_failed status and reason', () => {
  const secretUrl = 'https://user:secret-token@joereis.substack.com/feed?token=query-secret'
  const rawBody = '<rss>raw body token=super-secret-token</rss>'

  it('logs statusCode and a short reason only when both are known and safe', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        statusCode: 503,
        logReason: 'http_error',
        reason: `HTTP 503 ${secretUrl} ${rawBody}`,
        bytes: 12,
      }),
    ).toEqual({
      errorKind: 'fetch_failed',
      statusCode: 503,
      logReason: 'http_error',
    })
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        statusCode: 200,
        logReason: 'unsupported_content_type',
      }),
    ).toEqual({
      errorKind: 'fetch_failed',
      statusCode: 200,
      logReason: 'unsupported_content_type',
    })
    logFeed({
      stage: 'collect',
      durationMs: 4,
      errorKind: 'fetch_failed',
      sourceId: 'src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hostname: 'joereis.substack.com',
      statusCode: 403,
      logReason: 'http_error',
    })
    const parsed = loggedObject()
    expect(parsed).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 4,
      errorKind: 'fetch_failed',
      sourceId: 'src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hostname: 'joereis.substack.com',
      statusCode: 403,
      reason: 'http_error',
    })
    expect(String(parsed.message)).toBe('feed collect fetch_failed')
    expect(String(parsed.message)).not.toContain('403')
    expect(String(parsed.message)).not.toContain('http_error')
    expect(typeof parsed.statusCode).toBe('number')
  })

  it('omits statusCode when the fetch has no status and drops unsafe or overlong reasons', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const longReason = 'a'.repeat(49)
    const maxReason = `T${'a'.repeat(47)}`
    expect(longReason).toHaveLength(49)
    expect(maxReason).toHaveLength(48)
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        reason: `TypeError: ${secretUrl} ${rawBody}`,
        logReason: `TypeError: ${secretUrl}`,
      }),
    ).toEqual({ errorKind: 'fetch_failed' })
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        reason: 'HTTP 503',
      }),
    ).toEqual({ errorKind: 'fetch_failed' })
    expect(feedCollectionErrorLog({ kind: 'fetch_failed', logReason: 'timeout' })).toEqual({
      errorKind: 'fetch_failed',
      logReason: 'timeout',
    })
    expect(feedCollectionErrorLog({ kind: 'fetch_failed', logReason: 'TypeError' })).toEqual({
      errorKind: 'fetch_failed',
      logReason: 'TypeError',
    })
    expect(feedCollectionErrorLog({ kind: 'fetch_failed', logReason: longReason })).toEqual({
      errorKind: 'fetch_failed',
    })
    expect(feedCollectionErrorLog({ kind: 'fetch_failed', logReason: maxReason })).toEqual({
      errorKind: 'fetch_failed',
      logReason: maxReason,
    })
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        statusCode: 99,
        logReason: 'http_error',
      }),
    ).toEqual({ errorKind: 'fetch_failed', logReason: 'http_error' })
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        statusCode: 600,
        logReason: 'http_error',
      }),
    ).toEqual({ errorKind: 'fetch_failed', logReason: 'http_error' })
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        statusCode: 503.5,
        logReason: 'http_error',
      }),
    ).toEqual({ errorKind: 'fetch_failed', logReason: 'http_error' })
    expect(
      feedCollectionErrorLog({
        kind: 'fetch_failed',
        statusCode: '503',
        logReason: 'http_error',
      }),
    ).toEqual({ errorKind: 'fetch_failed', logReason: 'http_error' })
    expect(
      feedCollectionErrorLog({
        kind: 'payload_too_large',
        bytes: 9,
        statusCode: 413,
        logReason: 'http_error',
        reason: secretUrl,
      }),
    ).toEqual({ errorKind: 'payload_too_large', bytes: 9 })
    expect(
      feedCollectionErrorLog({
        kind: 'invalid_feed',
        statusCode: 400,
        logReason: 'http_error',
        reason: rawBody,
      }),
    ).toEqual({ errorKind: 'invalid_feed' })

    logFeed({
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      hostname: 'seattledataguy.substack.com',
      logReason: 'timeout',
    })
    logFeed({
      stage: 'collect',
      durationMs: 2,
      errorKind: 'fetch_failed',
      statusCode: 404,
      logReason: `${secretUrl} ${rawBody}`,
    })
    logFeed({
      stage: 'collect',
      durationMs: 3,
      errorKind: 'internal_error',
      failurePoint: 'fetch',
      statusCode: 500,
      logReason: 'http_error',
    })
    const calls = vi.mocked(console.log).mock.calls.map((call) => call[0] as Record<string, unknown>)
    expect(calls[0]).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      hostname: 'seattledataguy.substack.com',
      reason: 'timeout',
    })
    expect(calls[0]).not.toHaveProperty('statusCode')
    expect(calls[1]).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 2,
      errorKind: 'fetch_failed',
      statusCode: 404,
    })
    expect(calls[1]).not.toHaveProperty('reason')
    expect(calls[2]).toEqual({
      message: 'feed collect internal_error fetch',
      event: 'feed',
      stage: 'collect',
      durationMs: 3,
      errorKind: 'internal_error',
      failurePoint: 'fetch',
    })
    expect(calls[2]).not.toHaveProperty('statusCode')
    expect(calls[2]).not.toHaveProperty('reason')
    const text = JSON.stringify(calls)
    expect(text).not.toContain('https://')
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('query-secret')
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('raw body')
    expect(text).not.toContain('substack.com/feed')
  })
})

describe('daily workers logs query', () => {
  it('documents the saved queries for the post-cron summary', () => {
    const doc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../docs/workers-logs.md'),
      'utf8',
    )
    expect(doc).toContain(
      '$metadata.service = "xteink-read-later" AND regex(event, "^(pipeline|daily_digest|opds_download|feed)$")',
    )
    expect(doc).toContain('$metadata.service = "xteink-read-later" AND event = "feed"')
    expect(doc).toContain('Cloudflare は入れ子の OR（grouped OR）を AND に正規化する。これらの保存クエリに grouped OR は使わない。')
    expect(doc).toContain('$metadata.service = "xteink-read-later" AND $workers.outcome = "exceededCpu"')
    expect(doc).toContain('errorKind')
    expect(doc).toContain('opds_download')
    expect(doc).toContain('payload_too_large')
    expect(doc).toContain('`payload_too_large` だけ `bytes`（数値）')
    expect(doc).toContain(
      '`hostname` はフィード URL のホスト名だけで、path と query は含めない。情報源が分かっている成功と失敗に付き、`event = "feed" AND hostname = "example.com"` で検索する。',
    )
    expect(doc).toContain('`fetch_failed` だけ、取れたとき `statusCode`（100–599 の整数）と短い `reason`')
    expect(doc).toContain(
      '`fetch_failed` の `statusCode` は、応答の HTTP ステータスが分かったときだけの整数である。ネットワーク例外やタイムアウトでステータスが無いときはフィールドを付けない。',
    )
    expect(doc).toContain('errorKind = "fetch_failed" AND statusCode = 403')
    expect(doc).toContain('例外の message、レスポンス本文、Content-Type の中身、トークン、フル URL、Secret は出さない')
    expect(doc).toContain('URL、本文、Secret、例外メッセージは付けない')
    expect(doc).toContain('errorKind = "payload_too_large"')
    expect(doc).toContain('internal_error')
    expect(doc).toContain('failurePoint')
    expect(doc).toContain('feed_schedule')
    expect(doc).toContain('予算スキップのまま残る `unevaluated` は候補ごとに出さない')
    expect(doc).toContain('`running` は途中進捗で、完了件数に数えない')
    expect(doc).toContain('`retry_exhausted` は CPU 超過を含むリトライ枯渇')
    expect(doc).toContain('watchdog')
  })
})
