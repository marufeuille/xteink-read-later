import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createClipPipeline } from '../../src/pipeline/clip'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryStore } from '../../src/store/memory'
import { basicAuthorization, bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from '../bindings'
import { createFakeQueue } from '../fake-queue'
import { installNetworkMock } from './mock-network'

const fixtures = dirname(fileURLToPath(import.meta.url))

function fixtureHtml(name: string): string {
  return readFileSync(join(fixtures, '..', 'fixtures', name), 'utf8')
}

function app() {
  const store = createMemoryStore()
  const candidateStore = createMemoryCandidateStore()
  const queue = createFakeQueue()
  const hono = createApp({ store, queue, candidateStore })
  const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
  return { hono, store, candidateStore, queue, env }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('candidate fixture e2e', () => {
  it('registers, lists by published date, and does not change clip queueing', async () => {
    installNetworkMock({
      pages: {
        'https://example.com/ja/workers-cpu': { html: fixtureHtml('ja-tech.html') },
        'https://notes.example.com/undated': { html: fixtureHtml('candidate-no-date.html') },
        'https://paywall.example.com/essay': { html: fixtureHtml('candidate-paywall.html') },
        'https://missing.example.com/gone': { html: 'nope', status: 404, contentType: 'text/plain' },
      },
    })
    const ctx = app()
    const headers = {
      'content-type': 'application/json',
      authorization: bearerAuthorization(),
    }

    const registered = await ctx.hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }) },
      ctx.env,
    )
    expect(registered.status).toBe(201)

    const undated = await ctx.hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://notes.example.com/undated' }) },
      ctx.env,
    )
    expect(undated.status).toBe(201)
    expect(((await undated.json()) as { candidate: { publishedAt: string | null } }).candidate.publishedAt).toBeNull()

    const paywalled = await ctx.hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://paywall.example.com/essay' }) },
      ctx.env,
    )
    expect(paywalled.status).toBe(201)
    expect(((await paywalled.json()) as { notice: { kind: string } }).notice.kind).toBe('paywalled')

    const failed = await ctx.hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://missing.example.com/gone' }) },
      ctx.env,
    )
    expect(failed.status).toBe(201)
    expect(((await failed.json()) as { notice: { kind: string } }).notice.kind).toBe('fetch_failed')

    const duplicate = await ctx.hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }) },
      ctx.env,
    )
    expect(duplicate.status).toBe(200)
    expect(((await duplicate.json()) as { duplicate: boolean }).duplicate).toBe(true)

    const listed = await ctx.hono.request('/candidates.json', { headers: { authorization: bearerAuthorization() } }, ctx.env)
    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as {
      timezone: string
      total: number
      groups: {
        date: string | null
        label: string
        items: {
          title: string
          publishedAt: string | null
          recommendation: { status: string; grade: string | null }
        }[]
      }[]
    }
    expect(listBody.timezone).toBe('Asia/Tokyo')
    expect(listBody.total).toBe(3)
    expect(listBody.groups.some((group) => group.label === '公開日不明')).toBe(true)
    const statuses = listBody.groups.flatMap((group) => group.items.map((item) => item.recommendation.status))
    expect(statuses).toContain('skipped')
    expect(statuses).toContain('insufficient_material')
    expect(
      listBody.groups.flatMap((group) => group.items).every((item) => item.recommendation.grade === null),
    ).toBe(true)
    expect(JSON.stringify(listBody)).not.toContain('Members only essay')
    expect(JSON.stringify(listBody)).not.toContain(TEST_CLIP_TOKEN)

    const unauth = await ctx.hono.request('/candidates.json', { headers: { accept: 'application/json' } }, ctx.env)
    expect(unauth.status).toBe(401)

    const clip = await ctx.hono.request(
      '/clip',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }) },
      ctx.env,
    )
    expect(clip.status).toBe(202)
    expect(((await clip.json()) as { status: string }).status).toBe('queued')
  })

  it('sends full text from the list and lists the completed EPUB in OPDS', async () => {
    installNetworkMock({
      pages: {
        'https://example.com/ja/workers-cpu': { html: fixtureHtml('ja-tech.html') },
      },
    })
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline()
    const hono = createApp({ store, queue, candidateStore })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
    const headers = {
      'content-type': 'application/json',
      authorization: bearerAuthorization(),
    }

    const registered = await hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }) },
      env,
    )
    expect(registered.status).toBe(201)
    const candidateId = ((await registered.json()) as { id: string }).id

    const sent = await hono.request(
      `/candidates/${candidateId}/clip`,
      { method: 'POST', headers, body: '{}' },
      env,
    )
    expect(sent.status).toBe(202)
    expect(((await sent.json()) as { deliveryState: string }).deliveryState).toBe('preparing')

    await queue.drain(env, { clipPipeline, store, candidateStore })

    const listed = await hono.request('/candidates.json', { headers: { authorization: bearerAuthorization() } }, env)
    const listBody = (await listed.json()) as {
      groups: { items: { deliveryState: string; availableInOpds: boolean; completedArticleId: string | null }[] }[]
    }
    const item = listBody.groups[0]?.items[0]
    expect(item?.deliveryState).toBe('available')
    expect(item?.availableInOpds).toBe(true)
    expect(item?.completedArticleId).toMatch(/^art_/)

    const catalog = await hono.request('/opds', { headers: { authorization: basicAuthorization() } }, env)
    expect(catalog.status).toBe(200)
    const xml = await catalog.text()
    expect(xml).toContain('Cloudflare Workers の CPU 制限')
    expect(xml).toContain(`opds/download/${item?.completedArticleId}.epub`)

    const epub = await hono.request(`/opds/download/${item?.completedArticleId}.epub`, {
      headers: { authorization: basicAuthorization() },
    }, env)
    expect(epub.status).toBe(200)
    expect(epub.headers.get('content-type')).toBe('application/epub+zip')
  })

  it('records a mocked Jev recommendation without hiding the candidate', async () => {
    installNetworkMock({
      pages: {
        'https://example.com/ja/workers-cpu': { html: fixtureHtml('ja-tech.html') },
      },
    })
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const queue = createFakeQueue()
    let jevCalls = 0
    const hono = createApp({
      store,
      queue,
      candidateStore,
      evaluateRecommend: async () => {
        jevCalls += 1
        return {
          ok: true,
          value: {
            model: 'jev-1.13.0',
            answers: {
              recommendation: {
                type: 'choice',
                choice: 'recommended',
                confidence: 0.9,
                probabilities: { recommended: 0.9 },
              },
              de_relevant: { type: 'noul', noul: 0.95 },
              has_concreteness: { type: 'noul', noul: 0.8 },
              has_verification: { type: 'noul', noul: 0.7 },
            },
            usage: { inputTokens: 300, outputTokens: 16 },
          },
        }
      },
    })
    const env = { ...TEST_BINDINGS, OPENROUTER_API_KEY: 'or-test', CLIP_QUEUE: queue } as Cloudflare.Env
    const headers = {
      'content-type': 'application/json',
      authorization: bearerAuthorization(),
    }
    const registered = await hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }) },
      env,
    )
    expect(registered.status).toBe(201)
    const body = (await registered.json()) as {
      candidate: { listingState: string; recommendation: { status: string; grade: string | null; reasons: string[] } }
    }
    expect(body.candidate.listingState).toBe('listed')
    expect(body.candidate.recommendation.status).toBe('evaluated')
    expect(body.candidate.recommendation.grade).toBe('recommended')
    expect(body.candidate.recommendation.reasons).toEqual([
      'de_relevant',
      'has_concreteness',
      'has_verification',
    ])

    const duplicate = await hono.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }) },
      env,
    )
    expect(duplicate.status).toBe(200)
    expect(((await duplicate.json()) as { duplicate: boolean; candidate: { recommendation: { grade: string } } }).candidate.recommendation.grade).toBe('recommended')
    expect(jevCalls).toBe(1)
  })

  it('keeps invalid Jev payloads and API failures listed without a grade', async () => {
    installNetworkMock({
      pages: {
        'https://example.com/ja/workers-cpu': { html: fixtureHtml('ja-tech.html') },
        'https://example.com/en/compatibility-date': { html: fixtureHtml('en-tech.html') },
      },
    })
    const invalidApp = createApp({
      store: createMemoryStore(),
      queue: createFakeQueue(),
      candidateStore: createMemoryCandidateStore(),
      evaluateRecommend: async () => ({
        ok: true,
        value: {
          model: 'jev-1.13.0',
          answers: {
            recommendation: { type: 'choice', choice: 'recommended', confidence: 0.9, probabilities: {} },
          },
          usage: { inputTokens: 10, outputTokens: 1 },
        },
      }),
    })
    const failApp = createApp({
      store: createMemoryStore(),
      queue: createFakeQueue(),
      candidateStore: createMemoryCandidateStore(),
      evaluateRecommend: async () => ({
        ok: false,
        error: { kind: 'jev_failed', code: 'http', reason: '503' },
      }),
    })
    const headers = {
      'content-type': 'application/json',
      authorization: bearerAuthorization(),
    }
    const env = { ...TEST_BINDINGS, OPENROUTER_API_KEY: 'or-test', CLIP_QUEUE: createFakeQueue() } as Cloudflare.Env
    const invalid = await invalidApp.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }) },
      env,
    )
    const invalidBody = (await invalid.json()) as {
      candidate: { listingState: string; recommendation: { status: string; grade: string | null } }
    }
    expect(invalid.status).toBe(201)
    expect(invalidBody.candidate.listingState).toBe('listed')
    expect(invalidBody.candidate.recommendation.status).toBe('failed')
    expect(invalidBody.candidate.recommendation.grade).toBeNull()

    const failed = await failApp.request(
      '/candidates',
      { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/en/compatibility-date' }) },
      { ...TEST_BINDINGS, OPENROUTER_API_KEY: 'or-test', CLIP_QUEUE: createFakeQueue() } as Cloudflare.Env,
    )
    const failedBody = (await failed.json()) as {
      candidate: { listingState: string; recommendation: { status: string; grade: string | null } }
    }
    expect(failed.status).toBe(201)
    expect(failedBody.candidate.listingState).toBe('listed')
    expect(failedBody.candidate.recommendation.status).toBe('failed')
    expect(failedBody.candidate.recommendation.grade).toBeNull()
  })
})
