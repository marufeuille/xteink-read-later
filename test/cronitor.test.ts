import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExtractPipeline } from '../src/extract/pipeline'
import { runScheduledFeedCollection } from '../src/feeds/schedule'
import { unavailableClassification } from '../src/classify/taxonomy'
import { createClipPipeline } from '../src/pipeline/clip'
import { CLIP_QUEUE_NAME, createClipQueueHandler } from '../src/queue/clip'
import { handleScheduled } from '../src/schedule'
import { createMemoryFeedSourceStore } from '../src/store/memory-sources'
import { createMemoryStore } from '../src/store/memory'
import {
  CRONITOR_API_KEY_BINDING,
  CRONITOR_CLIP_FAIL_MESSAGE,
  CRONITOR_CLIP_MONITOR_KEY_BINDING,
  CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
  CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
  CRONITOR_PING_TIMEOUT_MS,
  CRONITOR_TELEMETRY_ORIGIN,
  traceCronitorJob,
} from '../src/telemetry/cronitor'
import {
  asClipJobId,
  asClipRunId,
  asFeedSourceId,
  err,
  FEED_COLLECT_CRON,
  ok,
  parseHttpUrl,
  type ClipPipeline,
  type ClipQueueMessage,
  type FeedSource,
  type HttpUrl,
  type TranslateArticle,
} from '../src/types'
import { TEST_BINDINGS } from './bindings'
import {
  createCronitorFetch,
  createHangingCronitorFetch,
  createThrowingCronitorFetch,
  type RecordedCronitorPing,
} from './cronitor-fetch'
import { createFakeDigestQueue } from './fake-digest-queue'
import { createFakeFeedQueue } from './fake-feed-queue'
import { createFakeQueue } from './fake-queue'

const root = dirname(fileURLToPath(import.meta.url))
const API_KEY = 'cronitor-test-api'
const FEED_MONITOR = 'xteink-feed-collect'
const CLIP_MONITOR = 'xteink-clip'
const SECRET = 'telemetry-secret-must-not-leak'
const jaHtml = readFileSync(join(root, 'fixtures', 'ja-tech.html'), 'utf8')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function cronitorBindings(overrides: Record<string, string | undefined> = {}): Cloudflare.Env {
  return {
    ...TEST_BINDINGS,
    [CRONITOR_API_KEY_BINDING]: API_KEY,
    [CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING]: FEED_MONITOR,
    [CRONITOR_CLIP_MONITOR_KEY_BINDING]: CLIP_MONITOR,
    ...overrides,
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

function expectPingTransport(ping: RecordedCronitorPing, monitorKey: string): void {
  const url = new URL(ping.href)
  expect(url.origin).toBe(CRONITOR_TELEMETRY_ORIGIN)
  expect(url.pathname).toBe(`/p/${API_KEY}/${monitorKey}`)
  expect(ping.method).toBe('GET')
  expect(ping.redirect).toBe('manual')
  expect(ping.href).not.toContain(SECRET)
}

function expectRunThen(pings: readonly RecordedCronitorPing[], state: 'complete' | 'fail', monitorKey: string): void {
  expect(pings.map((ping) => ping.state)).toEqual(['run', state])
  expect(pings[0]?.series.length).toBeGreaterThan(0)
  expect(pings[1]?.series).toBe(pings[0]?.series)
  expect(pings[0]?.metrics.size).toBe(0)
  expect(pings[0]?.message).toBeNull()
  for (const ping of pings) {
    expectPingTransport(ping, monitorKey)
  }
}

function clipMessage(attempts = 1): Message<ClipQueueMessage> {
  return {
    id: 'msg_1',
    timestamp: new Date('2026-10-01T00:00:00.000Z'),
    attempts,
    body: {
      jobId: asClipJobId(`job_${'a'.repeat(32)}`),
      runId: asClipRunId(`run_${'b'.repeat(32)}`),
      url: mustUrl('https://example.com/ja/workers-cpu'),
    },
    ack() {},
    retry() {},
  } as Message<ClipQueueMessage>
}

function batchOf(messages: readonly Message<ClipQueueMessage>[]): MessageBatch<ClipQueueMessage> {
  return {
    messages: [...messages],
    queue: CLIP_QUEUE_NAME,
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

const jaTranslate: TranslateArticle = async (article) =>
  ok({
    ...article,
    language: 'ja',
    translated: false,
  })

describe('Cronitor job telemetry', () => {
  it('documents the Worker secret names and keeps the Access HTTP monitors', () => {
    const example = readFileSync(join(root, '..', '.dev.vars.example'), 'utf8')
    const docs = readFileSync(join(root, '..', 'docs', 'health-checks.md'), 'utf8')
    const index = readFileSync(join(root, '..', 'src', 'index.ts'), 'utf8')
    for (const name of [
      CRONITOR_API_KEY_BINDING,
      CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
      CRONITOR_CLIP_MONITOR_KEY_BINDING,
    ]) {
      expect(example).toContain(`${name}=`)
      expect(docs).toContain(name)
    }
    expect(docs).toContain('xteink-books-access-wall')
    expect(docs).toContain('xteink-digest-send-no-access')
    expect(docs).toContain(CRONITOR_FEED_COLLECT_FAIL_MESSAGE)
    expect(docs).toContain(CRONITOR_CLIP_FAIL_MESSAGE)
    expect(index).toContain('await handleScheduled(controller, env)')
    expect(index).toContain('createClipQueueHandler')
    expect(CRONITOR_PING_TIMEOUT_MS).toBe(2_000)
  })

  it('sends run then complete with count, duration, and error_count', async () => {
    const cronitor = createCronitorFetch()
    const stamps = [0, 2_500]
    let tick = 0
    const result = await traceCronitorJob({
      env: cronitorBindings(),
      monitorKeyBinding: CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
      fetch: cronitor.fetch,
      series: 'series-fixed',
      now: () => stamps[tick++] ?? 0,
      job: async () => ({ count: 4, errorCount: 0 }),
      metrics: (summary) => ({ count: summary.count, error_count: summary.errorCount }),
    })

    expect(result).toEqual({ count: 4, errorCount: 0 })
    expectRunThen(cronitor.pings, 'complete', FEED_MONITOR)
    expect(cronitor.pings[1]?.series).toBe('series-fixed')
    expect(cronitor.pings[1]?.message).toBeNull()
    expect(cronitor.pings[1]?.metrics.get('count')).toBe('4')
    expect(cronitor.pings[1]?.metrics.get('duration')).toBe('2.5')
    expect(cronitor.pings[1]?.metrics.get('error_count')).toBe('0')
    expect(cronitor.pings[1]?.href).toContain('metric=count%3A4')
    expect(cronitor.pings[1]?.href).toContain('metric=duration%3A2.5')
    expect(cronitor.pings[1]?.href).toContain('metric=error_count%3A0')
  })

  it('sends fail without the thrown error text, then rethrows', async () => {
    const cronitor = createCronitorFetch()
    const stamps = [100, 1_600]
    let tick = 0
    await expect(
      traceCronitorJob({
        env: cronitorBindings(),
        monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
        failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
        fetch: cronitor.fetch,
        now: () => stamps[tick++] ?? 0,
        job: async () => {
          throw new Error(`${SECRET} https://example.com/private`)
        },
        metrics: () => ({ count: 1, error_count: 0 }),
      }),
    ).rejects.toThrow(SECRET)

    expectRunThen(cronitor.pings, 'fail', CLIP_MONITOR)
    expect(cronitor.pings[1]?.message).toBe(CRONITOR_CLIP_FAIL_MESSAGE)
    expect(cronitor.pings[1]?.metrics.get('duration')).toBe('1.5')
    expect(cronitor.pings[1]?.metrics.get('error_count')).toBe('1')
    expect(cronitor.pings[1]?.metrics.has('count')).toBe(false)
    expect(cronitor.pings[1]?.href).not.toContain('example.com')
  })

  it('keeps the job result when Cronitor returns an error or throws', async () => {
    const failing = createCronitorFetch(() => new Response('nope', { status: 503 }))
    const thrown = createThrowingCronitorFetch(new Error(SECRET))
    const env = cronitorBindings()
    const options = {
      env,
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    } as const
    await expect(traceCronitorJob({ ...options, fetch: failing.fetch })).resolves.toBe('kept')
    await expect(traceCronitorJob({ ...options, fetch: thrown.fetch })).resolves.toBe('kept')
    expect(failing.pings).toHaveLength(2)
    expect(thrown.calls).toBe(2)
  })

  it('does not wait forever when Cronitor hangs', async () => {
    const started = Date.now()
    const result = await traceCronitorJob({
      env: cronitorBindings(),
      monitorKeyBinding: CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
      fetch: createHangingCronitorFetch(),
      timeoutMs: 30,
      job: async () => 'done',
      metrics: () => ({ count: 0, error_count: 0 }),
    })
    expect(result).toBe('done')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('skips pings when the API key or monitor key is missing or blank', async () => {
    const cronitor = createCronitorFetch()
    const cases = [
      {},
      { [CRONITOR_API_KEY_BINDING]: '' },
      { [CRONITOR_API_KEY_BINDING]: '   ', [CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING]: FEED_MONITOR },
      { [CRONITOR_API_KEY_BINDING]: API_KEY, [CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING]: ' ' },
      { [CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING]: FEED_MONITOR },
    ]
    for (const overrides of cases) {
      const result = await traceCronitorJob({
        env: { ...TEST_BINDINGS, ...overrides } as Cloudflare.Env,
        monitorKeyBinding: CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
        failMessage: CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
        fetch: cronitor.fetch,
        job: async () => 'ran',
        metrics: () => ({ count: 1, error_count: 0 }),
      })
      expect(result).toBe('ran')
    }
    expect(cronitor.pings).toEqual([])
  })

  it('encodes monitor keys so the telemetry host stays cronitor.link', async () => {
    const cronitor = createCronitorFetch()
    await traceCronitorJob({
      env: cronitorBindings({
        [CRONITOR_API_KEY_BINDING]: 'key/with space',
        [CRONITOR_CLIP_MONITOR_KEY_BINDING]: 'clip/key',
      }),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: cronitor.fetch,
      job: async () => 'ok',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    const href = cronitor.pings[0]?.href ?? ''
    const url = new URL(href)
    expect(url.origin).toBe(CRONITOR_TELEMETRY_ORIGIN)
    expect(href).toContain('/p/key%2Fwith%20space/clip%2Fkey')
  })
})

describe('scheduled feed collection telemetry', () => {
  it('sends run then complete for enabled sources and does not ping the digest', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(
      source({
        id: asFeedSourceId(`src_${'a'.repeat(32)}`),
        name: 'Zenn',
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
    )
    await sourceStore.put(
      source({
        id: asFeedSourceId(`src_${'b'.repeat(32)}`),
        name: 'Stopped',
        feedUrl: mustUrl('https://engineering.mercari.com/blog/feed.xml'),
        enabled: false,
      }),
    )
    const feed = createFakeFeedQueue()
    const digest = createFakeDigestQueue()
    const cronitor = createCronitorFetch()
    const env = {
      ...cronitorBindings(),
      FEED_QUEUE: feed,
      DIGEST_QUEUE: digest,
    } as Cloudflare.Env

    const scheduled = await handleScheduled({ cron: FEED_COLLECT_CRON }, env, {
      sourceStore,
      feedQueue: feed,
      digestQueue: digest,
      cronitorFetch: cronitor.fetch,
    })

    expect(scheduled.kinds).toEqual(['feed_collect', 'daily_digest'])
    expect(scheduled.failed).toBe(0)
    expect(feed.size).toBe(1)
    expect(digest.size).toBe(1)
    expectRunThen(cronitor.pings, 'complete', FEED_MONITOR)
    expect(cronitor.pings[1]?.metrics.get('count')).toBe('1')
    expect(cronitor.pings[1]?.metrics.get('error_count')).toBe('0')
    expect(cronitor.pings).toHaveLength(2)
  })

  it('sends fail when enqueue fails and omits the queue error text', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(
      source({
        id: asFeedSourceId(`src_${'c'.repeat(32)}`),
        name: 'Zenn',
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
    )
    const feed = createFakeFeedQueue({
      onSend: () => {
        throw new Error(`${SECRET} queue send failed`)
      },
    })
    const cronitor = createCronitorFetch()
    const result = await runScheduledFeedCollection(cronitorBindings(), {
      sourceStore,
      feedQueue: feed,
      cronitorFetch: cronitor.fetch,
    })

    expect(result.queued).toBe(0)
    expect(result.failed).toBe(1)
    expectRunThen(cronitor.pings, 'fail', FEED_MONITOR)
    expect(cronitor.pings[1]?.message).toBe(CRONITOR_FEED_COLLECT_FAIL_MESSAGE)
    expect(cronitor.pings[1]?.metrics.get('count')).toBe('1')
    expect(cronitor.pings[1]?.metrics.get('error_count')).toBe('1')
    expect(cronitor.pings[1]?.href).not.toContain('queue send failed')
  })

  it('still enqueues when the Cronitor ping throws', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(
      source({
        id: asFeedSourceId(`src_${'d'.repeat(32)}`),
        name: 'Zenn',
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
    )
    const feed = createFakeFeedQueue()
    const cronitor = createThrowingCronitorFetch(new Error(SECRET))
    const result = await runScheduledFeedCollection(cronitorBindings(), {
      sourceStore,
      feedQueue: feed,
      cronitorFetch: cronitor.fetch,
    })

    expect(result).toMatchObject({ queued: 1, failed: 0 })
    expect(feed.size).toBe(1)
    expect(cronitor.calls).toBe(2)
  })

  it('sends fail and rethrows when listing sources throws', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    const cronitor = createCronitorFetch()
    await expect(
      runScheduledFeedCollection(cronitorBindings(), {
        sourceStore: {
          ...sourceStore,
          listEnabled: () => Promise.reject(new Error(`${SECRET} d1 down`)),
        },
        feedQueue: createFakeFeedQueue(),
        cronitorFetch: cronitor.fetch,
      }),
    ).rejects.toThrow(SECRET)

    expectRunThen(cronitor.pings, 'fail', FEED_MONITOR)
    expect(cronitor.pings[1]?.href).not.toContain('d1 down')
  })

  it('uses global fetch when no test fetch is injected', async () => {
    const cronitor = createCronitorFetch()
    vi.stubGlobal('fetch', cronitor.fetch)
    const sourceStore = createMemoryFeedSourceStore()
    const result = await runScheduledFeedCollection(cronitorBindings(), {
      sourceStore,
      feedQueue: createFakeFeedQueue(),
    })
    expect(result).toMatchObject({ queued: 0, failed: 0 })
    expectRunThen(cronitor.pings, 'complete', FEED_MONITOR)
    expect(cronitor.pings[1]?.metrics.get('count')).toBe('0')
  })
})

describe('clip queue telemetry', () => {
  it('sends run then complete when a clip becomes ready', async () => {
    const store = createMemoryStore()
    const cronitor = createCronitorFetch()
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({
        fetchPage: async (url) =>
          ok({
            requestedUrl: url,
            finalUrl: url,
            contentType: 'text/html',
            html: jaHtml,
          }),
      }),
      translateArticle: jaTranslate,
    })
    const handler = createClipQueueHandler({
      store,
      clipPipeline,
      classifyArticle: async () => unavailableClassification('skipped'),
      cronitorFetch: cronitor.fetch,
    })
    await handler(batchOf([clipMessage()]), cronitorBindings())

    const job = await store.getJob(asClipJobId(`job_${'a'.repeat(32)}`))
    expect(job?.status).toBe('ready')
    expectRunThen(cronitor.pings, 'complete', CLIP_MONITOR)
    expect(cronitor.pings[1]?.metrics.get('count')).toBe('1')
    expect(cronitor.pings[1]?.metrics.get('error_count')).toBe('0')
    expect(cronitor.pings[1]?.href).not.toContain('example.com')
  })

  it('sends fail for a terminal clip error and complete while retries remain', async () => {
    const url = mustUrl('https://example.com/ja/workers-cpu')
    const failing: ClipPipeline = async () => err({ kind: 'extract_failed', url, reason: SECRET })
    const retrying: ClipPipeline = async () => err({ kind: 'fetch_failed', url, reason: SECRET })
    const terminal = createCronitorFetch()
    const retry = createCronitorFetch()
    await createClipQueueHandler({
      store: createMemoryStore(),
      clipPipeline: failing,
      cronitorFetch: terminal.fetch,
    })(batchOf([clipMessage()]), cronitorBindings())
    await createClipQueueHandler({
      store: createMemoryStore(),
      clipPipeline: retrying,
      cronitorFetch: retry.fetch,
    })(batchOf([clipMessage()]), cronitorBindings())

    expectRunThen(terminal.pings, 'fail', CLIP_MONITOR)
    expect(terminal.pings[1]?.message).toBe(CRONITOR_CLIP_FAIL_MESSAGE)
    expect(terminal.pings[1]?.metrics.get('error_count')).toBe('1')
    expect(terminal.pings[1]?.href).not.toContain(SECRET)
    expectRunThen(retry.pings, 'complete', CLIP_MONITOR)
    expect(retry.pings[1]?.metrics.get('error_count')).toBe('0')
    expect(retry.pings[1]?.href).not.toContain(SECRET)
  })

  it('sends fail for an invalid queue message', async () => {
    const cronitor = createCronitorFetch()
    const message = clipMessage()
    const invalid = { ...message, body: { jobId: 'nope' } } as Message<ClipQueueMessage>
    await createClipQueueHandler({
      store: createMemoryStore(),
      cronitorFetch: cronitor.fetch,
    })(batchOf([invalid]), cronitorBindings())

    expectRunThen(cronitor.pings, 'fail', CLIP_MONITOR)
    expect(cronitor.pings[1]?.metrics.get('count')).toBe('1')
    expect(cronitor.pings[1]?.metrics.get('error_count')).toBe('1')
  })

  it('still finishes the clip when Cronitor throws', async () => {
    const store = createMemoryStore()
    const cronitor = createThrowingCronitorFetch()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({
        fetchPage: async (url) =>
          ok({
            requestedUrl: url,
            finalUrl: url,
            contentType: 'text/html',
            html: jaHtml,
          }),
      }),
      translateArticle: jaTranslate,
    })
    const env = { ...cronitorBindings(), CLIP_QUEUE: queue } as Cloudflare.Env
    queue.push({
      jobId: asClipJobId(`job_${'e'.repeat(32)}`),
      runId: asClipRunId(`run_${'f'.repeat(32)}`),
      url: mustUrl('https://example.com/ja/workers-cpu'),
    })
    await queue.drain(env, {
      store,
      clipPipeline,
      classifyArticle: async () => unavailableClassification('skipped'),
      cronitorFetch: cronitor.fetch,
    })

    expect((await store.getJob(asClipJobId(`job_${'e'.repeat(32)}`)))?.status).toBe('ready')
    expect(cronitor.calls).toBe(2)
  })
})
