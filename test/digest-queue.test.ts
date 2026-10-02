import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIGEST_QUEUE_MAX_RETRIES, DIGEST_WATCHDOG_DELAY_SECONDS, isFinalDigestAttempt } from '../src/daily/budget'
import { buildDummyDailyWrite } from '../src/daily/issue'
import { publishLatestDaily } from '../src/daily/publish'
import {
  createMemoryDigestRunStore,
  createR2DigestRunStore,
  newDigestRunId,
  digestRunKey,
  type DigestRunRecord,
} from '../src/daily/run-store'
import { createDigestQueueHandler, DIGEST_QUEUE_NAME } from '../src/queue/digest'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryDigestStore } from '../src/store/memory-digest'
import { createMemoryStore } from '../src/store/memory'
import {
  asCandidateId,
  ok,
  parseHttpUrl,
  type CandidateArticle,
  type DigestQueueMessage,
  type HttpUrl,
} from '../src/types'
import { evaluatedRecommendation } from '../src/recommend/taxonomy'
import { TEST_BINDINGS } from './bindings'
import { createFakeDigestQueue, type FakeDigestQueue } from './fake-digest-queue'

const TODAY = '2026-09-21'
const NOW = new Date('2026-09-21T03:00:00.000Z')
const ORIGIN = mustUrl('https://read.example.com')

function mustUrl(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function listed(id: string, url: string, title: string): CandidateArticle {
  const canonicalUrl = mustUrl(url)
  const now = NOW.toISOString()
  return {
    id: asCandidateId(id),
    canonicalUrl,
    sourceUrl: canonicalUrl,
    title,
    outlet: 'example.com',
    publishedAt: '2026-09-21T00:00:00.000Z',
    discoveredAt: now,
    fetchStatus: 'fetched',
    listingState: 'listed',
    exclusionReason: null,
    fullTextState: 'confirmed_free',
    completedArticleId: null,
    clipJobId: null,
    clipRunId: null,
    selectedAt: null,
    recommendation: evaluatedRecommendation({
      grade: 'recommended',
      confidence: 0.9,
      model: 'test-model',
      excerptHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evaluatedAt: now,
      relevant: true,
      concrete: true,
      verification: true,
      inputTokens: 4,
      durationMs: 4,
    }),
    createdAt: now,
    updatedAt: now,
  }
}

function record(overrides: Partial<DigestRunRecord> & Pick<DigestRunRecord, 'runId'>): DigestRunRecord {
  const stamp = NOW.toISOString()
  return {
    v: 1,
    date: TODAY,
    status: 'running',
    phase: 'summarize',
    startedAt: stamp,
    updatedAt: stamp,
    planOffset: 0,
    pendingEval: [],
    evalIndex: 0,
    jevCalls: 0,
    selectedIds: [],
    summarizeIndex: 0,
    prepared: [],
    skipped: 0,
    exhaustedSkips: 0,
    articleId: null,
    qrCount: 0,
    ...overrides,
  }
}

function logsOf(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>)
}

async function deliver(
  queue: FakeDigestQueue,
  body: DigestQueueMessage,
  deps: Parameters<typeof createDigestQueueHandler>[0],
  attempts = 1,
): Promise<{ acked: boolean; retried: boolean }> {
  let acked = false
  let retried = false
  const batch: MessageBatch<DigestQueueMessage> = {
    messages: [
      {
        id: 'digest_msg',
        timestamp: NOW,
        body,
        attempts,
        ack() {
          acked = true
        },
        retry() {
          retried = true
        },
      },
    ],
    queue: DIGEST_QUEUE_NAME,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll() {
      for (const message of this.messages) {
        message.retry()
      }
    },
    ackAll() {
      acked = true
    },
  }
  await createDigestQueueHandler(deps)(batch, { ...TEST_BINDINGS, DIGEST_QUEUE: queue } as Cloudflare.Env)
  return { acked, retried }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('digest queue budget', () => {
  it('treats the delivery after max_retries as the final attempt', () => {
    expect(isFinalDigestAttempt(DIGEST_QUEUE_MAX_RETRIES)).toBe(false)
    expect(isFinalDigestAttempt(DIGEST_QUEUE_MAX_RETRIES + 1)).toBe(true)
  })
})

describe('digest queue steps', () => {
  it('splits summarize into one article per delivery and leaves a completion log', async () => {
    const candidateStore = createMemoryCandidateStore()
    const first = listed('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'https://example.com/a', '記事A')
    const second = listed('cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'https://example.com/b', '記事B')
    await candidateStore.put(first)
    await candidateStore.put({ ...second, discoveredAt: '2026-09-21T01:00:00.000Z' })
    const timeline: string[] = []
    const queue = createFakeDigestQueue({
      onSend(message) {
        timeline.push(`send:${message.step ?? 'start'}:${message.cursor ?? ''}`)
      },
    })
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    queue.push({ date: TODAY })
    await queue.drain({ ...TEST_BINDINGS, DIGEST_QUEUE: queue } as Cloudflare.Env, {
      store: createMemoryStore(),
      candidateStore,
      digestStore: createMemoryDigestStore(),
      runStore: createMemoryDigestRunStore(),
      now: () => NOW,
      fetchPage: async () => {
        throw new Error('fetch should not run')
      },
      summarize: async (candidate) => {
        timeline.push('summarize')
        return ok({
          candidateId: candidate.id,
          canonicalUrl: candidate.canonicalUrl,
          title: candidate.title,
          summaryHtml: `<p>要約 ${candidate.title}</p>`,
        })
      },
    })

    const summarizeAt = timeline.flatMap((item, index) => (item === 'summarize' ? [index] : []))
    expect(summarizeAt).toHaveLength(2)
    expect(timeline.slice(summarizeAt[0]! + 1, summarizeAt[1]).some((item) => item.startsWith('send:summarize'))).toBe(
      true,
    )
    expect(timeline).toContain(`send:watchdog:`)
    expect(queue.delayedSize).toBe(1)
    expect(queue.peek()).toEqual([{ date: TODAY, step: 'watchdog', runId: expect.any(String) }])

    const digestLogs = logsOf(spy).filter((entry) => entry.event === 'daily_digest')
    expect(digestLogs.filter((entry) => entry.status === 'published')).toEqual([
      expect.objectContaining({ message: 'daily_digest published', status: 'published', summarized: 2, qrCount: 0 }),
    ])
    expect(digestLogs.some((entry) => entry.status === 'running' && entry.stage === 'summarize')).toBe(true)
    expect(digestLogs.some((entry) => entry.status === 'running' && entry.stage === 'start')).toBe(true)
    const text = JSON.stringify(digestLogs)
    expect(text).not.toContain('https://')
    expect(text).not.toContain('<p>')
    expect(text).not.toContain('要約')
  })

  it('skips the heavy summary on the final attempt and still publishes the rest', async () => {
    const runStore = createMemoryDigestRunStore()
    const runId = newDigestRunId()
    const candidateStore = createMemoryCandidateStore()
    const kept = listed('cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'https://example.com/b', '残す記事')
    await candidateStore.put(kept)
    await runStore.put(
      record({
        runId,
        phase: 'summarize',
        selectedIds: [asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), kept.id],
        summarizeIndex: 0,
      }),
      null,
    )
    const summarize = vi.fn(async (candidate: CandidateArticle) =>
      ok({
        candidateId: candidate.id,
        canonicalUrl: candidate.canonicalUrl,
        title: candidate.title,
        summaryHtml: '<p>残す</p>',
      }),
    )
    const queue = createFakeDigestQueue()
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const deps = {
      store: createMemoryStore(),
      candidateStore,
      digestStore: createMemoryDigestStore(),
      runStore,
      now: () => NOW,
      fetchPage: async () => {
        throw new Error('fetch should not run')
      },
      summarize,
    }
    const skipped = await deliver(
      queue,
      { date: TODAY, step: 'summarize', runId, cursor: 0 },
      deps,
      DIGEST_QUEUE_MAX_RETRIES + 1,
    )
    expect(skipped).toEqual({ acked: true, retried: false })
    expect(summarize).not.toHaveBeenCalled()
    expect(queue.peek()).toEqual([{ date: TODAY, step: 'summarize', runId, cursor: 1 }])
    expect(logsOf(spy)).toContainEqual(
      expect.objectContaining({
        event: 'daily_digest',
        status: 'running',
        stage: 'summarize',
        errorKind: 'retry_exhausted',
        attempt: DIGEST_QUEUE_MAX_RETRIES + 1,
      }),
    )

    const continued = await deliver(queue, { date: TODAY, step: 'summarize', runId, cursor: 1 }, deps, 1)
    expect(continued.acked).toBe(true)
    expect(summarize).toHaveBeenCalledTimes(1)
    const publish = queue.peek().find((message) => message.step === 'publish')
    expect(publish).toEqual({ date: TODAY, step: 'publish', runId })
    const published = await deliver(queue, publish ?? { date: TODAY }, deps, 1)
    expect(published.acked).toBe(true)
    const stored = await runStore.get(TODAY)
    expect(stored?.record.status).toBe('published')
    expect(stored?.record.prepared).toHaveLength(1)
    expect(stored?.record.exhaustedSkips).toBe(1)
    expect(logsOf(spy).some((entry) => entry.status === 'published')).toBe(true)
  })

  it('records status failed on the final publish attempt without building another epub', async () => {
    const runStore = createMemoryDigestRunStore()
    const runId = newDigestRunId()
    const store = createMemoryStore()
    const yesterday = await buildDummyDailyWrite({ date: '2026-09-20', origin: ORIGIN, bodyMarker: 'old' })
    await publishLatestDaily(store, yesterday.write)
    await runStore.put(
      record({
        runId,
        phase: 'publish',
        selectedIds: [asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')],
        prepared: [
          {
            candidateId: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
            canonicalUrl: mustUrl('https://example.com/a'),
            title: '記事A',
            summaryHtml: '<p>要約</p>',
          },
        ],
      }),
      null,
    )
    let puts = 0
    const failingStore = {
      ...store,
      async put() {
        puts += 1
        throw new Error('publish failed')
      },
    }
    const queue = createFakeDigestQueue()
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const deps = {
      store: failingStore,
      candidateStore: createMemoryCandidateStore(),
      digestStore: createMemoryDigestStore(),
      runStore,
      now: () => NOW,
      fetchPage: async () => {
        throw new Error('fetch should not run')
      },
    }
    const first = await deliver(queue, { date: TODAY, step: 'publish', runId }, deps, 1)
    expect(first).toEqual({ acked: false, retried: true })
    expect(puts).toBe(1)
    expect(logsOf(spy).some((entry) => entry.status === 'failed')).toBe(false)

    const last = await deliver(queue, { date: TODAY, step: 'publish', runId }, deps, DIGEST_QUEUE_MAX_RETRIES + 1)
    expect(last).toEqual({ acked: true, retried: false })
    expect(puts).toBe(1)
    expect(logsOf(spy)).toContainEqual(
      expect.objectContaining({
        message: 'daily_digest publish failed retry_exhausted',
        event: 'daily_digest',
        status: 'failed',
        stage: 'publish',
        errorKind: 'retry_exhausted',
      }),
    )
    const titles = (await store.listMeta()).map((item) => item.title)
    expect(titles.some((title) => title.startsWith('まとめ '))).toBe(false)
    expect(await runStore.get(TODAY)).toMatchObject({ record: { status: 'failed' } })
  })

  it('lets a stale watchdog mark the day failed when retries never return', async () => {
    const runStore = createMemoryDigestRunStore()
    const runId = newDigestRunId()
    const store = createMemoryStore()
    const yesterday = await buildDummyDailyWrite({ date: '2026-09-20', origin: ORIGIN, bodyMarker: 'old' })
    await publishLatestDaily(store, yesterday.write)
    await runStore.put(
      record({
        runId,
        phase: 'evaluate',
        updatedAt: '2020-01-01T00:00:00.000Z',
        startedAt: '2020-01-01T00:00:00.000Z',
      }),
      null,
    )
    const queue = createFakeDigestQueue()
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await deliver(
      queue,
      { date: TODAY, step: 'watchdog', runId },
      {
        store,
        candidateStore: createMemoryCandidateStore(),
        digestStore: createMemoryDigestStore(),
        runStore,
        now: () => NOW,
        fetchPage: async () => {
          throw new Error('fetch should not run')
        },
      },
      1,
    )
    expect(result).toEqual({ acked: true, retried: false })
    expect(logsOf(spy)).toContainEqual(
      expect.objectContaining({
        event: 'daily_digest',
        status: 'failed',
        stage: 'watchdog',
        errorKind: 'retry_exhausted',
      }),
    )
    expect((await store.listMeta()).some((item) => item.title.startsWith('まとめ '))).toBe(false)
  })

  it('requeues a fresh watchdog instead of failing the run', async () => {
    const runStore = createMemoryDigestRunStore()
    const runId = newDigestRunId()
    await runStore.put(record({ runId, phase: 'summarize' }), null)
    const sent: number[] = []
    const queue = createFakeDigestQueue({
      onSend(_message, sendOptions) {
        sent.push(sendOptions?.delaySeconds ?? -1)
      },
    })
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await deliver(
      queue,
      { date: TODAY, step: 'watchdog', runId },
      {
        store: createMemoryStore(),
        candidateStore: createMemoryCandidateStore(),
        digestStore: createMemoryDigestStore(),
        runStore,
        now: () => NOW,
        fetchPage: async () => {
          throw new Error('fetch should not run')
        },
      },
      1,
    )
    expect(result).toEqual({ acked: true, retried: false })
    expect(queue.delayedSize).toBe(1)
    expect(queue.peek()).toEqual([{ date: TODAY, step: 'watchdog', runId }])
    expect(sent).toEqual([DIGEST_WATCHDOG_DELAY_SECONDS])
    expect(logsOf(spy).some((entry) => entry.status === 'failed')).toBe(false)
    expect((await runStore.get(TODAY))?.record.status).toBe('running')
  })

  it('acks an invalid message without retrying', async () => {
    const queue = createFakeDigestQueue()
    const result = await deliver(queue, { date: 'yesterday' }, {
      store: createMemoryStore(),
      candidateStore: createMemoryCandidateStore(),
      digestStore: createMemoryDigestStore(),
      runStore: createMemoryDigestRunStore(),
      now: () => NOW,
      fetchPage: async () => {
        throw new Error('fetch should not run')
      },
    })
    expect(result).toEqual({ acked: true, retried: false })
    expect(queue.size).toBe(0)
  })
})

describe('digest run store', () => {
  it('keeps the checkpoint outside article and job prefixes and rejects a stale write', async () => {
    expect(digestRunKey(TODAY)).toBe('digest-runs/2026-09-21.json')
    const store = createMemoryDigestRunStore()
    const runId = newDigestRunId()
    const first = await store.put(record({ runId }), null)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const stale = await store.put(record({ runId, skipped: 1 }), null)
    expect(stale).toEqual({ ok: false })
    const next = await store.put(record({ runId, skipped: 2 }), first.etag)
    expect(next.ok).toBe(true)
    expect((await store.get(TODAY))?.record.skipped).toBe(2)
  })

  it('uses an R2 conditional put so two deliveries cannot both advance', async () => {
    let object: { body: string; etag: string } | null = null
    let version = 0
    const bucket = {
      async get(key: string) {
        expect(key).toBe(digestRunKey(TODAY))
        if (object === null) {
          return null
        }
        const body = object.body
        return {
          etag: object.etag,
          async json() {
            return JSON.parse(body) as unknown
          },
        }
      },
      async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
        expect(key.startsWith('articles/')).toBe(false)
        expect(key.startsWith('jobs/')).toBe(false)
        const onlyIf = options?.onlyIf
        if (onlyIf?.etagDoesNotMatch === '*' && object !== null) {
          return null
        }
        if (onlyIf?.etagMatches !== undefined && (object === null || object.etag !== onlyIf.etagMatches)) {
          return null
        }
        version += 1
        object = { body: value, etag: `etag-${version}` }
        return { etag: object.etag }
      },
    }
    const store = createR2DigestRunStore({ ARTICLES: bucket as unknown as R2Bucket })
    const runId = newDigestRunId()
    const created = await store.put(record({ runId, prepared: [] }), null)
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    expect(await store.put(record({ runId, skipped: 1 }), null)).toEqual({ ok: false })
    const saved = await store.put(
      record({
        runId,
        skipped: 4,
        prepared: [
          {
            candidateId: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
            canonicalUrl: mustUrl('https://example.com/a'),
            title: '記事A',
            summaryHtml: '<p>要約</p>',
          },
        ],
      }),
      created.etag,
    )
    expect(saved.ok).toBe(true)
    const loaded = await store.get(TODAY)
    expect(loaded?.record.skipped).toBe(4)
    expect(loaded?.record.prepared[0]?.summaryHtml).toBe('<p>要約</p>')
  })
})
