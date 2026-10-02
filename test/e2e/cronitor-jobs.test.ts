import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { clipPipeline } from '../../src/pipeline/clip'
import { CLIP_QUEUE_NAME, createClipQueueHandler } from '../../src/queue/clip'
import { createD1CandidateStore } from '../../src/store/d1-candidates'
import { handleScheduled } from '../../src/schedule'
import { createR2Store } from '../../src/store/r2'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import {
  CRONITOR_API_KEY_BINDING,
  CRONITOR_CLIP_MONITOR_KEY_BINDING,
  CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
  CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
  CRONITOR_TELEMETRY_ORIGIN,
} from '../../src/telemetry/cronitor'
import { cronitorIpv4Fetch, resetCronitorDnsCache } from '../../src/telemetry/cronitor-ipv4'
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
  type RecordedCronitorPing,
} from '../cronitor-fetch'
import { createScriptedCronitorConnect, httpResponse } from '../cronitor-ipv4-harness'
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
  resetCronitorDnsCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
    expect(ping.cache).toBe('no-store')
    expect(ping.href).not.toContain(PAGE_URL)
    expect(ping.href).not.toContain(EMPTY_URL)
    expect(ping.href).not.toContain(SECRET)
  }
}

function cronitorLogLines(): Record<string, unknown>[] {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call[0])
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && (value as { event?: unknown }).event === 'cronitor',
    )
}

function expectNoTelemetrySecrets(logs: readonly Record<string, unknown>[], forbidden: readonly string[]): void {
  const text = JSON.stringify(logs)
  for (const secret of forbidden) {
    expect(text).not.toContain(secret)
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

function installWorkerFetch(): { readonly cronitorFetches: string[] } {
  const pages: Record<string, string> = {
    [PAGE_URL]: fixture('ja-tech.html'),
    [EMPTY_URL]: fixture('empty.html'),
  }
  const cronitorFetches: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(href)
      if (url.origin === CRONITOR_TELEMETRY_ORIGIN || url.hostname === 'eu.cronitor.link') {
        cronitorFetches.push(href)
        throw new Error('plain fetch must not call cronitor')
      }
      if (url.origin === 'https://cloudflare-dns.com') {
        return new Response(JSON.stringify({ Answer: [{ type: 1, TTL: 60, data: '1.2.3.4' }] }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        })
      }
      const html = pages[href]
      if (html === undefined) {
        throw new Error(`unexpected network fetch: ${url}`)
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }),
  )
  return { cronitorFetches }
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
    vi.spyOn(console, 'log').mockImplementation(() => {})
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
    const logs = cronitorLogLines()
    expect(logs.map((entry) => entry.message)).toEqual(['cronitor sent run', 'cronitor sent complete'])
    expectNoTelemetrySecrets(logs, [API_KEY, FEED_MONITOR, 'https://zenn.dev'])
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
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const collected = await runCollect(okStore, okQueue, thrown.fetch)
    expect(collected.failed).toBe(0)
    expect(okQueue.size).toBe(1)
    expect(thrown.calls).toBe(2)
    const logs = cronitorLogLines()
    expect(logs.map((entry) => entry.outcome)).toEqual(['network', 'network'])
    expectNoTelemetrySecrets(logs, [SECRET, API_KEY, FEED_MONITOR, PAGE_URL])
  })

  it('uses the ipv4 socket path from the clip queue export and still marks the job ready', async () => {
    const bucket = createFakeR2Bucket()
    const env = envWithCronitor({ ARTICLES: bucket })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { cronitorFetches } = installWorkerFetch()
    const jobId = `job_${'a'.repeat(32)}`
    await worker.queue(clipBatch(PAGE_URL, jobId, `run_${'b'.repeat(32)}`), env)

    const job = await createR2Store(env).getJob(asClipJobId(jobId))
    expect(job?.status).toBe('ready')
    expect(cronitorFetches).toEqual([])
    const logs = cronitorLogLines()
    expect(logs.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(logs[0]).toMatchObject({ outcome: 'network', pingState: 'run', transport: 'ipv4', cause: 'connect' })
    expect(logs[1]).toMatchObject({ outcome: 'network', pingState: 'complete', transport: 'ipv4', cause: 'connect' })
    expectNoTelemetrySecrets(logs, [API_KEY, CLIP_MONITOR, PAGE_URL, '1.2.3.4', 'cloudflare-sockets-stub'])
  })

  it('pings fail when the clip export cannot extract, without putting the page URL in telemetry', async () => {
    const bucket = createFakeR2Bucket()
    const env = envWithCronitor({ ARTICLES: bucket })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { cronitorFetches } = installWorkerFetch()
    const jobId = `job_${'d'.repeat(32)}`
    await worker.queue(clipBatch(EMPTY_URL, jobId, `run_${'e'.repeat(32)}`), env)

    const job = await createR2Store(env).getJob(asClipJobId(jobId))
    expect(job?.status).toBe('failed')
    expect(job?.error?.code).toBe('extract_failed')
    expect(cronitorFetches).toEqual([])
    const logs = cronitorLogLines()
    expect(logs.map((entry) => entry.pingState)).toEqual(['run', 'fail'])
    expect(logs[0]).toMatchObject({ transport: 'ipv4', cause: 'connect' })
    expect(logs[1]).toMatchObject({ outcome: 'network', pingState: 'fail', transport: 'ipv4', cause: 'connect' })
    expectNoTelemetrySecrets(logs, [API_KEY, CLIP_MONITOR, PAGE_URL, EMPTY_URL, '1.2.3.4', 'cloudflare-sockets-stub'])
  })

  it('still finishes the clip export when the socket dial throws', async () => {
    const bucket = createFakeR2Bucket()
    const env = envWithCronitor({ ARTICLES: bucket })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { cronitorFetches } = installWorkerFetch()
    const jobId = `job_${'f'.repeat(32)}`
    await worker.queue(clipBatch(PAGE_URL, jobId, `run_${'1'.repeat(32)}`), env)

    const job = await createR2Store(env).getJob(asClipJobId(jobId))
    expect(job?.status).toBe('ready')
    expect(cronitorFetches).toEqual([])
    const logs = cronitorLogLines()
    expect(logs.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(logs[0]).toMatchObject({ transport: 'ipv4', cause: 'connect' })
    expectNoTelemetrySecrets(logs, [SECRET, API_KEY, CLIP_MONITOR, PAGE_URL, 'cloudflare-sockets-stub'])
  })

  it('collects the feed when the ipv4 socket sends, and when the dial fails', async () => {
    const enabled = source({
      id: asFeedSourceId(`src_${'e'.repeat(32)}`),
      name: 'Zenn',
      feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
    })
    const okStore = createMemoryFeedSourceStore()
    await okStore.put(enabled)
    const okQueue = createFakeFeedQueue()
    const scripted = createScriptedCronitorConnect(() =>
      httpResponse(200, { 'Content-Type': 'application/json', 'Content-Length': '0' }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const sent = await runCollect(
      okStore,
      okQueue,
      (input, init) =>
        cronitorIpv4Fetch(input, init, {
          connect: scripted.connect,
          lookup: async () => ['44.230.87.160'],
        }),
    )
    expect(sent.failed).toBe(0)
    expect(okQueue.size).toBe(1)
    expect(scripted.dials.length).toBeGreaterThanOrEqual(2)
    expect(scripted.dials.every((dial) => dial.hostname === '44.230.87.160')).toBe(true)
    expect(scripted.dials.every((dial) => dial.sni === 'cronitor.link')).toBe(true)
    const sentLogs = cronitorLogLines()
    expect(sentLogs.map((entry) => entry.message)).toEqual(['cronitor sent run', 'cronitor sent complete'])
    expect(sentLogs[0]).toMatchObject({ outcome: 'sent', transport: 'ipv4' })
    expect(sentLogs[1]).toMatchObject({ outcome: 'sent', pingState: 'complete', transport: 'ipv4' })
    expectNoTelemetrySecrets(sentLogs, [API_KEY, FEED_MONITOR, '44.230.87.160', PAGE_URL])

    const failStore = createMemoryFeedSourceStore()
    await failStore.put({ ...enabled, id: asFeedSourceId(`src_${'f'.repeat(32)}`) })
    const failQueue = createFakeFeedQueue()
    const failing = createScriptedCronitorConnect(() => new Error(`${SECRET} dial-failure-token`))
    const collected = await runCollect(
      failStore,
      failQueue,
      (input, init) =>
        cronitorIpv4Fetch(input, init, {
          connect: failing.connect,
          lookup: async () => ['1.2.3.4'],
        }),
    )
    expect(collected.failed).toBe(0)
    expect(failQueue.size).toBe(1)
    const failedLogs = cronitorLogLines().slice(sentLogs.length)
    expect(failedLogs.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(failedLogs[0]).toMatchObject({ outcome: 'network', transport: 'ipv4', cause: 'connect' })
    expectNoTelemetrySecrets(failedLogs, [SECRET, API_KEY, FEED_MONITOR, '1.2.3.4', 'dial-failure-token', PAGE_URL])
  })

  it('still finishes the clip export when Cronitor returns a non-2xx body', async () => {
    const bucket = createFakeR2Bucket()
    const env = envWithCronitor({ ARTICLES: bucket })
    const body = 'secret-body-must-not-leak'
    const cronitor = createCronitorFetch(() => new Response(body, { status: 500 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    installWorkerFetch()
    const handler = createClipQueueHandler({
      clipPipeline,
      createStore: createR2Store,
      createCandidateStore: createD1CandidateStore,
      cronitorFetch: cronitor.fetch,
    })
    const jobId = `job_${'2'.repeat(32)}`
    await handler(clipBatch(PAGE_URL, jobId, `run_${'3'.repeat(32)}`), env)

    const job = await createR2Store(env).getJob(asClipJobId(jobId))
    expect(job?.status).toBe('ready')
    expect(cronitor.pings).toHaveLength(2)
    expect(cronitor.pings[0]?.cache).toBe('no-store')
    const logs = cronitorLogLines()
    expect(logs.map((entry) => entry.message)).toEqual(['cronitor http_error run', 'cronitor http_error complete'])
    expect(logs[0]).toMatchObject({ outcome: 'http_error', pingState: 'run', httpStatus: 500 })
    expect(logs[1]).toMatchObject({ outcome: 'http_error', pingState: 'complete', httpStatus: 500 })
    expectNoTelemetrySecrets(logs, [body, API_KEY, CLIP_MONITOR, PAGE_URL, SECRET])
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
