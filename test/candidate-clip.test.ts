import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { sendCandidateClip } from '../src/candidates/clip'
import { resolveCandidateDelivery } from '../src/candidates/delivery'
import { createExtractPipeline } from '../src/extract/pipeline'
import { createClipPipeline } from '../src/pipeline/clip'
import { logCandidateClip, logOpdsDownload } from '../src/log'
import { unevaluatedRecommendation } from '../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryStore } from '../src/store/memory'
import {
  asArticleId,
  asCandidateId,
  asClipJobId,
  asClipRunId,
  clipJobIdFromUrl,
  ok,
  parseHttpUrl,
  type CandidateArticle,
  type ClipPipeline,
  type FetchPage,
  type HttpUrl,
  type TranslateArticle,
} from '../src/types'
import { bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'
import { createFakeQueue } from './fake-queue'

const fixtures = dirname(fileURLToPath(import.meta.url))

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

const jaTranslate: TranslateArticle = async (article) =>
  ok({
    ...article,
    language: 'ja',
    translated: article.language !== 'ja',
    title: article.language === 'ja' ? article.title : `${article.title}（日本語）`,
  })

const jaTechPage: FetchPage = async (url) =>
  ok({
    requestedUrl: url,
    finalUrl: url,
    contentType: 'text/html',
    html: html('ja-tech.html'),
  })

function listedCandidate(overrides: Partial<CandidateArticle> & Pick<CandidateArticle, 'id' | 'canonicalUrl'>): CandidateArticle {
  const now = '2026-09-21T03:00:00.000Z'
  return {
    sourceUrl: overrides.canonicalUrl,
    title: 'Cloudflare Workers の CPU 制限',
    outlet: 'example.com',
    publishedAt: '2026-03-01T00:00:00.000Z',
    discoveredAt: now,
    fetchStatus: 'fetched',
    listingState: 'listed',
    exclusionReason: null,
    fullTextState: 'confirmed_free',
    completedArticleId: null,
    clipJobId: null,
    clipRunId: null,
    selectedAt: null,
    recommendation: unevaluatedRecommendation(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('resolveCandidateDelivery', () => {
  const candidate = listedCandidate({
    id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    canonicalUrl: mustUrl('https://example.com/ja/workers-cpu'),
  })

  it('keeps unsent when there is no job or EPUB', () => {
    const view = resolveCandidateDelivery({
      candidate,
      job: null,
      articlePresent: false,
      articleId: null,
      nowMs: Date.now(),
    })
    expect(view.deliveryState).toBe('unsent')
    expect(view.availableInOpds).toBe(false)
  })

  it('marks available only when the EPUB is present', () => {
    const view = resolveCandidateDelivery({
      candidate,
      job: {
        jobId: asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        runId: asClipRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        sourceUrl: candidate.canonicalUrl,
        status: 'ready',
        articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        error: null,
        attempt: 1,
        stages: [],
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      },
      articlePresent: true,
      articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      nowMs: Date.now(),
    })
    expect(view.deliveryState).toBe('available')
    expect(view.availableInOpds).toBe(true)
  })

  it('does not treat a ready job without EPUB as available', () => {
    const view = resolveCandidateDelivery({
      candidate,
      job: {
        jobId: asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        runId: asClipRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        sourceUrl: candidate.canonicalUrl,
        status: 'ready',
        articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        error: null,
        attempt: 1,
        stages: [],
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      },
      articlePresent: false,
      articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      nowMs: Date.now(),
    })
    expect(view.deliveryState).toBe('failed')
    expect(view.availableInOpds).toBe(false)
  })
})

describe('sendCandidateClip', () => {
  it('rejects paywalled and fetch-failed articles', async () => {
    const store = createMemoryCandidateStore()
    const articleStore = createMemoryStore()
    const queue = createFakeQueue()
    const paywalled = listedCandidate({
      id: asCandidateId('cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      canonicalUrl: mustUrl('https://paywall.example.com/essay'),
      listingState: 'excluded',
      exclusionReason: 'paywalled',
      fullTextState: 'unavailable',
    })
    const failed = listedCandidate({
      id: asCandidateId('cand_cccccccccccccccccccccccccccccccc'),
      canonicalUrl: mustUrl('https://missing.example.com/gone'),
      fetchStatus: 'fetch_failed',
      fullTextState: 'unconfirmed',
    })
    await store.put(paywalled)
    await store.put(failed)
    const paywalledResult = await sendCandidateClip({
      candidateId: paywalled.id,
      regenerate: false,
      candidateStore: store,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:00:00.000Z'),
    })
    expect(paywalledResult.ok).toBe(false)
    if (!paywalledResult.ok) {
      expect(paywalledResult.error.kind).toBe('candidate_unsendable')
    }
    const failedResult = await sendCandidateClip({
      candidateId: failed.id,
      regenerate: false,
      candidateStore: store,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:00:00.000Z'),
    })
    expect(failedResult.ok).toBe(false)
    if (!failedResult.ok) {
      expect(failedResult.error.kind).toBe('candidate_unsendable')
    }
    expect(queue.size).toBe(0)
  })

  it('enqueues once on double send and reuses a completed EPUB unless regenerate is set', async () => {
    const candidateStore = createMemoryCandidateStore()
    const articleStore = createMemoryStore()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({ fetchPage: jaTechPage }),
      translateArticle: jaTranslate,
    })
    const url = mustUrl('https://example.com/ja/workers-cpu')
    const candidate = listedCandidate({
      id: asCandidateId('cand_dddddddddddddddddddddddddddddddd'),
      canonicalUrl: url,
    })
    await candidateStore.put(candidate)
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
    const first = await sendCandidateClip({
      candidateId: candidate.id,
      regenerate: false,
      candidateStore,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:00:00.000Z'),
    })
    const second = await sendCandidateClip({
      candidateId: candidate.id,
      regenerate: false,
      candidateStore,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:00:01.000Z'),
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      return
    }
    expect(queue.size).toBe(1)
    expect(second.value.reused).toBe(true)
    expect(first.value.body.jobId).toBe(second.value.body.jobId)
    expect(first.value.candidate.selectedAt).toBe('2026-09-21T04:00:00.000Z')
    expect(second.value.candidate.selectedAt).toBe('2026-09-21T04:00:00.000Z')

    await queue.drain(env, { clipPipeline, store: articleStore, candidateStore })
    const linked = await candidateStore.getById(candidate.id)
    expect(linked?.completedArticleId).toMatch(/^art_/)
    expect(linked?.clipJobId).toBe(first.value.body.jobId)

    const reused = await sendCandidateClip({
      candidateId: candidate.id,
      regenerate: false,
      candidateStore,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:05:00.000Z'),
    })
    expect(reused.ok).toBe(true)
    if (!reused.ok) {
      return
    }
    expect(reused.value.reused).toBe(true)
    expect(reused.value.body.deliveryState).toBe('available')
    expect(queue.size).toBe(0)

    const regenerated = await sendCandidateClip({
      candidateId: candidate.id,
      regenerate: true,
      candidateStore,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:06:00.000Z'),
    })
    expect(regenerated.ok).toBe(true)
    if (!regenerated.ok) {
      return
    }
    expect(regenerated.value.regenerated).toBe(true)
    expect(queue.size).toBe(1)
    expect(regenerated.value.body.runId).not.toBe(first.value.body.runId)
  })

  it('records the mapping before a queue send failure so retry can recover', async () => {
    const candidateStore = createMemoryCandidateStore()
    const articleStore = createMemoryStore()
    let failSend = true
    const queue = createFakeQueue({
      onSend: () => {
        if (failSend) {
          failSend = false
          throw new Error('queue unavailable')
        }
      },
    })
    const url = mustUrl('https://example.com/ja/workers-cpu')
    const candidate = listedCandidate({
      id: asCandidateId('cand_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
      canonicalUrl: url,
    })
    await candidateStore.put(candidate)
    const failed = await sendCandidateClip({
      candidateId: candidate.id,
      regenerate: false,
      candidateStore,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:00:00.000Z'),
    })
    expect(failed.ok).toBe(false)
    const mapped = await candidateStore.getById(candidate.id)
    expect(mapped?.clipJobId).toBe(await clipJobIdFromUrl(url))
    expect(mapped?.selectedAt).toBe('2026-09-21T04:00:00.000Z')
    const retry = await sendCandidateClip({
      candidateId: candidate.id,
      regenerate: false,
      candidateStore,
      articleStore,
      queue,
      now: () => new Date('2026-09-21T04:01:00.000Z'),
    })
    expect(retry.ok).toBe(true)
    expect(queue.size).toBe(1)
  })
})

describe('candidate clip HTTP', () => {
  function appWith() {
    const candidateStore = createMemoryCandidateStore()
    const store = createMemoryStore()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({ fetchPage: jaTechPage }),
      translateArticle: jaTranslate,
    })
    const app = createApp({ store, queue, candidateStore, fetchPage: jaTechPage })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
    return { app, candidateStore, store, queue, clipPipeline, env }
  }

  async function drain(
    queue: ReturnType<typeof createFakeQueue>,
    env: Cloudflare.Env,
    deps: { clipPipeline: ClipPipeline; store: ReturnType<typeof createMemoryStore>; candidateStore: ReturnType<typeof createMemoryCandidateStore> },
  ) {
    await queue.drain(env, deps)
  }

  it('rejects unauthenticated clip sends', async () => {
    const { app, env } = appWith()
    const response = await app.request(
      '/candidates/cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: '{}',
      },
      env,
    )
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(TEST_CLIP_TOKEN)
  })

  it('sends from the list, shows preparing then OPDS available, and does not confuse download/read', async () => {
    const ctx = appWith()
    const created = await ctx.app.request(
      '/candidates',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      ctx.env,
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { id: string }
    const sent = await ctx.app.request(
      `/candidates/${createdBody.id}/clip`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: '{}',
      },
      ctx.env,
    )
    expect(sent.status).toBe(202)
    const sentBody = (await sent.json()) as {
      jobId: string
      runId: string
      deliveryState: string
      reused: boolean
    }
    expect(sentBody.deliveryState).toBe('preparing')
    expect(sentBody.reused).toBe(false)

    const listed = await ctx.app.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization() } },
      ctx.env,
    )
    const listBody = (await listed.json()) as {
      groups: { items: { deliveryState: string; availableInOpds: boolean; title: string }[] }[]
    }
    expect(listBody.groups[0]?.items[0]?.deliveryState).toBe('preparing')
    expect(listBody.groups[0]?.items[0]?.availableInOpds).toBe(false)

    await drain(ctx.queue, ctx.env, ctx)
    const readyList = await ctx.app.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization() } },
      ctx.env,
    )
    const readyBody = (await readyList.json()) as {
      groups: { items: { deliveryState: string; availableInOpds: boolean; completedArticleId: string | null }[] }[]
    }
    expect(readyBody.groups[0]?.items[0]?.deliveryState).toBe('available')
    expect(readyBody.groups[0]?.items[0]?.availableInOpds).toBe(true)
    expect(readyBody.groups[0]?.items[0]?.completedArticleId).toMatch(/^art_/)

    const htmlList = await ctx.app.request('/candidates', { headers: { authorization: bearerAuthorization() } }, ctx.env)
    const htmlText = await htmlList.text()
    expect(htmlText).toContain('OPDSで取得可能')
    expect(htmlText).toContain('再生成')
    expect(htmlText).toContain('端末のダウンロード済みや読了ではありません')
    expect(htmlText).not.toContain(TEST_CLIP_TOKEN)
  })
})

describe('candidate and OPDS logs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes selection and download JSON without URL, body, or token', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logCandidateClip({
      action: 'select',
      candidateId: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      jobId: asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      runId: asClipRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      selectedAt: '2026-09-21T04:00:00.000Z',
      discoveredAt: '2026-09-21T03:00:00.000Z',
      publishedAt: '2026-03-01T00:00:00.000Z',
      reused: false,
      regenerated: false,
    })
    logOpdsDownload({
      articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      durationMs: 12,
    })
    const lines = spy.mock.calls.map((call) => String(call[0]))
    expect(lines.join('\n')).not.toContain('https://')
    expect(lines.join('\n')).not.toContain('<p>')
    expect(lines.join('\n')).not.toContain(TEST_CLIP_TOKEN)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'candidate_clip', action: 'select' })
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ event: 'opds_download' })
  })
})
