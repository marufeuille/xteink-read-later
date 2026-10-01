import { afterEach, describe, expect, it, vi } from 'vitest'
import { feedFailurePoint, FeedStageError, runFeedStage } from '../src/feeds/failure-point'
import { logFeed, type FeedFailurePoint } from '../src/log'
import {
  createFeedQueueHandler,
  FEED_QUEUE_MAX_RETRIES,
  type FeedQueueHandlerDeps,
} from '../src/queue/feed'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryFeedSourceStore } from '../src/store/memory-sources'
import {
  asFeedRunId,
  asFeedSourceId,
  err,
  ok,
  parseHttpUrl,
  type CandidateStore,
  type FeedQueueMessage,
  type FeedSource,
  type FeedSourceStore,
  type FetchFeed,
  type FetchPage,
  type HttpUrl,
} from '../src/types'

const SOURCE_ID = asFeedSourceId('src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const RUN_ID = asFeedRunId('frun_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const LEAK = 'ECONNRESET https://attacker.example/private token=super-secret-token <item>raw body</item>'
const LEAK_MARKERS = ['ECONNRESET', 'attacker.example', 'super-secret-token', 'raw body', 'SecretLeakError']
const STATIC_FAILURE = 'Feed collection failed after an unexpected error'
const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example</title>
<item><title>Post</title><link>https://example.com/post</link></item>
</channel></rss>`

afterEach(() => {
  vi.restoreAllMocks()
})

class SecretLeakError extends Error {
  override readonly name = 'SecretLeakError'

  constructor() {
    super(LEAK)
  }
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(`bad url ${value}`)
  }
  return url
}

function baseSource(): FeedSource {
  return {
    id: SOURCE_ID,
    name: 'Example',
    siteUrl: mustUrl('https://example.com/'),
    feedUrl: mustUrl('https://example.com/feed.xml'),
    sourceType: 'posting_site',
    topicTags: [],
    enabled: true,
    collectionRunId: RUN_ID,
    collectionStatus: 'queued',
    collectionAttempt: 0,
    collectionErrorCode: null,
    collectionErrorMessage: null,
    itemsSeen: 0,
    itemsRegistered: 0,
    itemsDuplicate: 0,
    itemsSkipped: 0,
    lastCollectedAt: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }
}

const fetchPage: FetchPage = async (url) => err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })

const fetchRss: FetchFeed = async (url) =>
  ok({
    requestedUrl: url,
    finalUrl: url,
    contentType: 'application/rss+xml',
    xml: RSS,
  })

function candidateStoreThatThrows(error: Error): CandidateStore {
  const inner = createMemoryCandidateStore()
  return {
    ...inner,
    async getByCanonicalUrl() {
      throw error
    },
  }
}

function expectNoLeak(value: unknown): void {
  const text = JSON.stringify(value)
  for (const marker of LEAK_MARKERS) {
    expect(text).not.toContain(marker)
  }
}

async function deliver(
  deps: FeedQueueHandlerDeps,
  attempts: number,
): Promise<{ acked: boolean; retried: boolean; logs: Record<string, unknown>[] }> {
  const logs: Record<string, unknown>[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'object' && line !== null) {
      logs.push(line as Record<string, unknown>)
    }
  })
  let acked = false
  let retried = false
  const handler = createFeedQueueHandler(deps)
  const batch: MessageBatch<FeedQueueMessage> = {
    messages: [
      {
        id: 'feed_msg',
        timestamp: new Date('2026-09-21T19:00:00.000Z'),
        body: { sourceId: SOURCE_ID, runId: RUN_ID },
        attempts,
        ack() {
          acked = true
        },
        retry() {
          retried = true
        },
      },
    ],
    queue: 'xteink-read-later-feed',
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll() {
      for (const message of this.messages) {
        message.ack()
      }
    },
    retryAll() {
      for (const message of this.messages) {
        message.retry()
      }
    },
  }
  await handler(batch, {} as Cloudflare.Env)
  return { acked, retried, logs }
}

function feedLogs(logs: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return logs.filter((entry) => entry.event === 'feed')
}

type Stage = 'fetch' | 'parse' | 'store'

function depsFor(stage: Stage, sourceStore: FeedSourceStore, thrown: () => never): FeedQueueHandlerDeps {
  const deps: FeedQueueHandlerDeps = {
    sourceStore,
    candidateStore: stage === 'store' ? candidateStoreThatThrows(new SecretLeakError()) : createMemoryCandidateStore(),
    fetchFeed: stage === 'fetch' ? async () => thrown() : fetchRss,
    fetchPage,
    now: () => new Date('2026-09-21T19:00:00.000Z'),
  }
  if (stage === 'parse') {
    return { ...deps, parseFeed: () => thrown() }
  }
  return deps
}

describe('feed internal_error failurePoint', () => {
  it.each(['fetch', 'parse', 'store'] as const)(
    'classifies a thrown %s failure, retries, and keeps the exception out of the log and D1',
    async (stage) => {
      const sourceStore = createMemoryFeedSourceStore()
      await sourceStore.put(baseSource())
      const thrown = (): never => {
        throw new SecretLeakError()
      }
      const first = await deliver(depsFor(stage, sourceStore, thrown), 1)
      const running = await sourceStore.getById(SOURCE_ID)

      expect(first.retried).toBe(true)
      expect(first.acked).toBe(false)
      expect(feedLogs(first.logs)).toEqual([
        {
          message: `feed collect internal_error ${stage}`,
          event: 'feed',
          stage: 'collect',
          durationMs: expect.any(Number),
          errorKind: 'internal_error',
          failurePoint: stage,
          sourceId: SOURCE_ID,
          runId: RUN_ID,
          attempt: 1,
        },
      ])
      expect(running).toMatchObject({
        collectionStatus: 'running',
        collectionAttempt: 1,
        collectionErrorCode: null,
        collectionErrorMessage: null,
      })
      expectNoLeak(first.logs)
      expectNoLeak(running)

      const last = await deliver(depsFor(stage, sourceStore, thrown), FEED_QUEUE_MAX_RETRIES + 1)
      const failed = await sourceStore.getById(SOURCE_ID)
      expect(last.retried).toBe(false)
      expect(last.acked).toBe(true)
      expect(feedLogs(last.logs)).toEqual([
        expect.objectContaining({
          message: `feed collect internal_error ${stage}`,
          event: 'feed',
          errorKind: 'internal_error',
          failurePoint: stage,
          attempt: FEED_QUEUE_MAX_RETRIES + 1,
        }),
      ])
      expect(failed).toMatchObject({
        collectionStatus: 'failed',
        collectionAttempt: FEED_QUEUE_MAX_RETRIES + 1,
        collectionErrorCode: 'internal_error',
        collectionErrorMessage: STATIC_FAILURE,
      })
      expect(failed).not.toHaveProperty('failurePoint')
      expectNoLeak(last.logs)
      expectNoLeak(failed)
    },
  )

  it('classifies a non-Error fetch throw without copying the thrown value', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(baseSource())
    const result = await deliver(
      depsFor('fetch', sourceStore, () => {
        throw LEAK
      }),
      1,
    )
    expect(feedLogs(result.logs)[0]).toMatchObject({
      errorKind: 'internal_error',
      failurePoint: 'fetch',
    })
    expectNoLeak(result.logs)
    expectNoLeak(await sourceStore.getById(SOURCE_ID))
  })

  it('classifies a source-record write failure as store and still retries', async () => {
    const inner = createMemoryFeedSourceStore()
    await inner.put(baseSource())
    let writes = 0
    const sourceStore: FeedSourceStore = {
      getById: (id) => inner.getById(id),
      getByFeedUrl: (feedUrl) => inner.getByFeedUrl(feedUrl),
      list: () => inner.list(),
      listEnabled: () => inner.listEnabled(),
      async put(source) {
        writes += 1
        if (writes > 1) {
          throw new SecretLeakError()
        }
        await inner.put(source)
      },
    }
    const result = await deliver(
      {
        sourceStore,
        candidateStore: createMemoryCandidateStore(),
        fetchFeed: async (url) =>
          ok({
            requestedUrl: url,
            finalUrl: url,
            contentType: 'text/html',
            xml: '<html>not a feed</html>',
          }),
        fetchPage,
        now: () => new Date('2026-09-21T19:00:00.000Z'),
      },
      1,
    )
    expect(result.retried).toBe(true)
    expect(result.acked).toBe(false)
    expect(feedLogs(result.logs)).toEqual([
      expect.objectContaining({
        message: 'feed collect internal_error store',
        errorKind: 'internal_error',
        failurePoint: 'store',
        attempt: 1,
      }),
    ])
    expect(await inner.getById(SOURCE_ID)).toMatchObject({
      collectionStatus: 'running',
      collectionErrorCode: null,
      collectionErrorMessage: null,
    })
    expectNoLeak(result.logs)
    expectNoLeak(await inner.getById(SOURCE_ID))
  })

  it('keeps returned fetch_failed on errorKind and retries without failurePoint', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(baseSource())
    const result = await deliver(
      {
        sourceStore,
        candidateStore: createMemoryCandidateStore(),
        fetchFeed: async (url) => err({ kind: 'fetch_failed', url, reason: 'HTTP 503' }),
        fetchPage,
        now: () => new Date('2026-09-21T19:00:00.000Z'),
      },
      1,
    )
    expect(result.retried).toBe(true)
    expect(result.acked).toBe(false)
    expect(feedLogs(result.logs)).toEqual([
      {
        message: 'feed collect fetch_failed',
        event: 'feed',
        stage: 'collect',
        durationMs: expect.any(Number),
        errorKind: 'fetch_failed',
        sourceId: SOURCE_ID,
        runId: RUN_ID,
        attempt: 1,
      },
    ])
    expect(JSON.stringify(result.logs)).not.toContain('https://')
    expect(JSON.stringify(result.logs)).not.toContain('failurePoint')
    expect(await sourceStore.getById(SOURCE_ID)).toMatchObject({
      collectionStatus: 'running',
      collectionErrorCode: null,
    })
  })

  it('logs payload_too_large with a numeric size and without the feed url or exception text', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(baseSource())
    const secret = 'token=super-secret-token'
    const result = await deliver(
      {
        sourceStore,
        candidateStore: createMemoryCandidateStore(),
        fetchFeed: async (url) => {
          expect(url).toContain('example.com')
          return err({ kind: 'payload_too_large', bytes: 3_385_152 })
        },
        fetchPage,
        now: () => new Date('2026-09-21T19:00:00.000Z'),
      },
      1,
    )
    expect(result.retried).toBe(false)
    expect(result.acked).toBe(true)
    expect(feedLogs(result.logs)).toEqual([
      {
        message: 'feed collect payload_too_large',
        event: 'feed',
        stage: 'collect',
        durationMs: expect.any(Number),
        errorKind: 'payload_too_large',
        bytes: 3_385_152,
        sourceId: SOURCE_ID,
        runId: RUN_ID,
        attempt: 1,
      },
    ])
    const logged = feedLogs(result.logs)[0]
    expect(typeof logged?.bytes).toBe('number')
    expect(logged).not.toHaveProperty('url')
    expect(logged).not.toHaveProperty('reason')
    expect(logged).not.toHaveProperty('body')
    const text = JSON.stringify(result.logs)
    expect(text).not.toContain('https://')
    expect(text).not.toContain(secret)
    expect(text).not.toContain('Payload exceeded')
    expect(text).not.toContain('example.com/feed.xml')
    const stored = await sourceStore.getById(SOURCE_ID)
    expect(stored).toMatchObject({
      collectionStatus: 'failed',
      collectionErrorCode: 'payload_too_large',
    })
    expect(stored?.collectionErrorMessage).toContain('3385152')
    expect(text).not.toContain(stored?.collectionErrorMessage ?? 'Payload exceeded')
  })

  it('omits failurePoint when collection succeeds', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(baseSource())
    const result = await deliver(
      {
        sourceStore,
        candidateStore: createMemoryCandidateStore(),
        fetchFeed: fetchRss,
        fetchPage,
        now: () => new Date('2026-09-21T19:00:00.000Z'),
      },
      1,
    )
    expect(result.acked).toBe(true)
    expect(result.retried).toBe(false)
    expect(feedLogs(result.logs)).toEqual([
      {
        message: 'feed collect',
        event: 'feed',
        stage: 'collect',
        durationMs: expect.any(Number),
        sourceId: SOURCE_ID,
        runId: RUN_ID,
        attempt: 1,
      },
    ])
    expect(await sourceStore.getById(SOURCE_ID)).toMatchObject({
      collectionStatus: 'ready',
      collectionErrorCode: null,
      collectionErrorMessage: null,
    })
    expect(JSON.stringify(result.logs)).not.toContain('https://')
    expect(JSON.stringify(result.logs)).not.toContain('failurePoint')
  })

  it('drops unsafe failurePoint text and plain exceptions to unknown', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    logFeed({
      stage: 'collect',
      durationMs: 1,
      errorKind: 'internal_error',
      failurePoint: 'https://attacker.example/token=super-secret-token' as FeedFailurePoint,
    })
    logFeed({
      stage: 'collect',
      durationMs: 2,
      errorKind: 'fetch_failed',
      failurePoint: 'store' as FeedFailurePoint,
    })
    const calls = vi.mocked(console.log).mock.calls.map((call) => call[0] as Record<string, unknown>)
    expect(calls[0]).toEqual({
      message: 'feed collect internal_error unknown',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'internal_error',
      failurePoint: 'unknown',
    })
    expect(calls[1]).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 2,
      errorKind: 'fetch_failed',
    })
    expect(feedFailurePoint(new SecretLeakError())).toBe('unknown')
    expect(feedFailurePoint(LEAK)).toBe('unknown')
    expect(feedFailurePoint(new FeedStageError('parse'))).toBe('parse')
    expectNoLeak(calls)
  })

  it('replaces a stage exception with a point and does not keep the cause', async () => {
    const error = await runFeedStage('parse', () => {
      throw new SecretLeakError()
    }).then(
      () => {
        throw new Error('expected rejection')
      },
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(FeedStageError)
    expect(error).toMatchObject({ name: 'FeedStageError', failurePoint: 'parse' })
    expect(String(error)).toBe('FeedStageError: Feed collection failed')
    expect((error as Error).cause).toBeUndefined()
    expectNoLeak(String(error))
    expect(feedFailurePoint(error)).toBe('parse')
  })
})
