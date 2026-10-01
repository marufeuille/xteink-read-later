import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { CLIP_QUEUE_NAME } from '../../src/queue/clip'
import { handleScheduled } from '../../src/schedule'
import { createR2Store } from '../../src/store/r2'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import {
  CRONITOR_API_KEY_BINDING,
  CRONITOR_CLIP_FAIL_MESSAGE,
  CRONITOR_CLIP_MONITOR_KEY_BINDING,
  CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
  CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
  CRONITOR_TELEMETRY_ORIGIN,
} from '../../src/telemetry/cronitor'
import {
  asClipJobId,
  asClipRunId,
  asFeedSourceId,
  FEED_COLLECT_CRON,
  parseHttpUrl,
  type ClipQueueMessage,
  type FeedSource,
  type HttpUrl,
} from '../../src/types'
import { TEST_BINDINGS } from '../bindings'
import {
  createCronitorFetch,
  createThrowingCronitorFetch,
  readCronitorPing,
  type RecordedCronitorPing,
} from '../cronitor-fetch'
import { createFakeDigestQueue } from '../fake-digest-queue'
import { createFakeFeedQueue } from '../fake-feed-queue'
import { createFakeR2Bucket } from '../fake-r2'

const fixtures = dirname(fileURLToPath(import.meta.url))
const API_KEY = 'cronitor-test-api'
const FEED_MONITOR = 'xteink-feed-collect'
const CLIP_MONITOR = 'xteink-clip'
const PAGE_URL = 'https://example.com/ja/workers-cpu'
const EMPTY_URL = 'https://example.com/empty'
const SECRET = 'telemetry-secret-must-not-leak'

afterEach(() => {
  vi.unstubAllGlobals()
})

function fixture(name: string): string {
  return readFileSync(join(fixtures, '..', 'fixtures', name), 'utf8')
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function envWithCronitor(extra: Record<string, unknown> = {}): Cloudflare.Env {
  return {
    ...TEST_BINDINGS,
    [CRONITOR_API_KEY_BINDING]: API_KEY,
    [CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING]: FEED_MONITOR,
    [CRONITOR_CLIP_MONITOR_KEY_BINDING]: CLIP_MONITOR,
    ...extra,
  } as Cloudflare.Env
}

function source(partial: Partial<FeedSource> & Pick<FeedSource, 'id' | 'name' | 'feedUrl'>): FeedSource {
  return {
    siteUrl: mustUrl('https://example.com/'),
    sourceType: 'corporate_blog',
    topicTags: [],
    enabled: true,
    collectionRunId: null,
    collectionStatus: null,
    collectionAttempt: 0,
    collectionErrorCode: null,
    collectionErrorMessage: null,
    itemsSeen: 0,
    itemsRegistered: 0,
    itemsDuplicate: 0,
    itemsSkipped: 0,
    lastCollectedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...partial,
  }
}

function expectRunThen(pings: readonly RecordedCronitorPing[], state: 'complete' | 'fail', monitorKey: string): void {
  expect(pings.map((ping) => ping.state)).toEqual(['run', state])
  expect(pings[0]?.series).toBeTruthy()
  expect(pings[1]?.series).toBe(pings[0]?.series)
  expect(pings[0]?.metrics.size).toBe(0)
  for (const ping of pings) {
    const url = new URL(ping.href)
    expect(url.origin).toBe(CRONITOR_TELEMETRY_ORIGIN)
    expect(url.pathname).toBe(`/p/${API_KEY}/${monitorKey}`)
    expect(ping.method).toBe('GET')
    expect(ping.redirect).toBe('manual')
    expect(ping.href).not.toContain(PAGE_URL)
    expect(ping.href).not.toContain(EMPTY_URL)
    expect(ping.href).not.toContain(SECRET)
  }
}

function clipBatch(url: string, jobId: string, runId: string): MessageBatch<ClipQueueMessage> {
  return {
    queue: CLIP_QUEUE_NAME,
    messages: [
      {
        id: 'msg_1',
        timestamp: new Date('2026-10-01T00:00:00.000Z'),
        attempts: 1,
        body: {
          jobId: asClipJobId(jobId),
          runId: asClipRunId(runId),
          url: mustUrl(url),
        },
        ack() {},
        retry() {},
      },
    ],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll() {
      for (const message of this.messages) {
        message.retry()
      }
    },
    ackAll() {
      for (const message of this.messages) {
        message.ack()
      }
    },
  }
}

function installWorkerFetch(options: { readonly throwCronitor?: boolean } = {}): { readonly pings: RecordedCronitorPing[] } {
  const pages: Record<string, string> = {
    [PAGE_URL]: fixture('ja-tech.html'),
    [EMPTY_URL]: fixture('empty.html'),
  }
  const pings: RecordedCronitorPing[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url).origin === CRONITOR_TELEMETRY_ORIGIN) {
        pings.push(readCronitorPing(input, init))
        if (options.throwCronitor === true) {
          throw new Error(`cronitor ${SECRET}`)
        }
        return new Response('ok')
      }
      const html = pages[url]
      if (html === undefined) {
        throw new Error(`unexpected network fetch: ${url}`)
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }),
  )
  return { pings }
}

describe('Cronitor job telemetry e2e', () => {
  it('pings run then complete from the scheduled feed collection entry', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(
      source({
        id: asFeedSourceId(`src_${'a'.repeat(32)}`),
        name: 'Zenn',
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
    )
    const feed = createFakeFeedQueue()
    const digest = createFakeDigestQueue()
    const cronitor = createCronitorFetch()
    const env = envWithCronitor({ FEED_QUEUE: feed, DIGEST_QUEUE: digest })
    const scheduled = await handleScheduled({ cron: FEED_COLLECT_CRON }, env, {
      sourceStore,
      feedQueue: feed,
      digestQueue: digest,
      cronitorFetch: cronitor.fetch,
    })

    expect(scheduled.kinds).toEqual(['feed_collect', 'daily_digest'])
    expect(feed.size).toBe(1)
    expect(digest.size).toBe(1)
    expectRunThen(cronitor.pings, 'complete', FEED_MONITOR)
    expect(cronitor.pings[1]?.metrics.get('count')).toBe('1')
    expect(cronitor.pings[1]?.metrics.get('error_count')).toBe('0')
    expect(cronitor.pings[1]?.message).toBeNull()
  })

  it('pings fail when scheduled enqueue fails, and still collects when Cronitor throws', async () => {
    const enabled = source({
      id: asFeedSourceId(`src_${'b'.repeat(32)}`),
      name: 'Zenn',
      feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
    })
    const failingStore = createMemoryFeedSourceStore()
    await failingStore.put(enabled)
    const failingQueue = createFakeFeedQueue({
      onSend: () => {
        throw new Error(`${SECRET} queue send failed`)
      },
    })
    const failingPing = createCronitorFetch()
    const failed = await runCollect(failingStore, failingQueue, failingPing.fetch)
    expect(failingQueue.size).toBe(0)
    expect(failed.failed).toBe(1)
    expectRunThen(failingPing.pings, 'fail', FEED_MONITOR)
    expect(failingPing.pings[1]?.message).toBe(CRONITOR_FEED_COLLECT_FAIL_MESSAGE)
    expect(failingPing.pings[1]?.metrics.get('error_count')).toBe('1')

    const okStore = createMemoryFeedSourceStore()
    await okStore.put({ ...enabled, id: asFeedSourceId(`src_${'c'.repeat(32)}`) })
    const okQueue = createFakeFeedQueue()
    const thrown = createThrowingCronitorFetch(new Error(SECRET))
    const collected = await runCollect(okStore, okQueue, thrown.fetch)
    expect(collected.failed).toBe(0)
    expect(okQueue.size).toBe(1)
    expect(thrown.calls).toBe(2)
  })

  it('pings run then complete from the clip queue export', async () => {
    const bucket = createFakeR2Bucket()
    const env = envWithCronitor({ ARTICLES: bucket })
    const { pings } = installWorkerFetch()
    const jobId = `job_${'a'.repeat(32)}`
    await worker.queue(clipBatch(PAGE_URL, jobId, `run_${'b'.repeat(32)}`), env)

    const job = await createR2Store(env).getJob(asClipJobId(jobId))
    expect(job?.status).toBe('ready')
    expectRunThen(pings, 'complete', CLIP_MONITOR)
    expect(pings[1]?.metrics.get('count')).toBe('1')
    expect(pings[1]?.metrics.get('error_count')).toBe('0')
    expect(pings[1]?.message).toBeNull()
  })

  it('pings fail when the clip export cannot extract, without putting the page URL in telemetry', async () => {
    const bucket = createFakeR2Bucket()
    const env = envWithCronitor({ ARTICLES: bucket })
    const { pings } = installWorkerFetch()
    const jobId = `job_${'d'.repeat(32)}`
    await worker.queue(clipBatch(EMPTY_URL, jobId, `run_${'e'.repeat(32)}`), env)

    const job = await createR2Store(env).getJob(asClipJobId(jobId))
    expect(job?.status).toBe('failed')
    expect(job?.error?.code).toBe('extract_failed')
    expectRunThen(pings, 'fail', CLIP_MONITOR)
    expect(pings[1]?.message).toBe(CRONITOR_CLIP_FAIL_MESSAGE)
    expect(pings[1]?.metrics.get('count')).toBe('1')
    expect(pings[1]?.metrics.get('error_count')).toBe('1')
  })

  it('still finishes the clip export when Cronitor throws', async () => {
    const bucket = createFakeR2Bucket()
    const env = envWithCronitor({ ARTICLES: bucket })
    const { pings } = installWorkerFetch({ throwCronitor: true })
    const jobId = `job_${'f'.repeat(32)}`
    await worker.queue(clipBatch(PAGE_URL, jobId, `run_${'1'.repeat(32)}`), env)

    const job = await createR2Store(env).getJob(asClipJobId(jobId))
    expect(job?.status).toBe('ready')
    expect(pings).toHaveLength(2)
    expect(pings.map((ping) => ping.state)).toEqual(['run', 'complete'])
  })
})

async function runCollect(
  sourceStore: ReturnType<typeof createMemoryFeedSourceStore>,
  feedQueue: ReturnType<typeof createFakeFeedQueue>,
  cronitorFetch: typeof fetch,
) {
  const digest = createFakeDigestQueue()
  return handleScheduled({ cron: FEED_COLLECT_CRON }, envWithCronitor({ FEED_QUEUE: feedQueue, DIGEST_QUEUE: digest }), {
    sourceStore,
    feedQueue,
    digestQueue: digest,
    cronitorFetch,
  })
}
