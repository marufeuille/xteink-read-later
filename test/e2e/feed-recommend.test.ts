import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import { createMemoryStore } from '../../src/store/memory'
import type { EvaluateSystemOne } from '../../src/types'
import { bearerAuthorization, TEST_BINDINGS } from '../bindings'
import { createFakeFeedQueue } from '../fake-feed-queue'
import { createFakeQueue } from '../fake-queue'
import { installNetworkMock } from './mock-network'

const fixtures = dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return readFileSync(join(fixtures, '..', 'fixtures', name), 'utf8')
}

function articleHtml(url: string, title: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><title>${title}</title><link rel="canonical" href="${url}" /></head>
<body><article><h1>${title}</h1><p>${title} の本文です。候補登録の抽出が通るだけの長さを持たせます。Cloudflare Workers。</p>
<p>二段落目も入れて最小文字数を超えます。</p></article></body></html>`
}

const FEED = 'https://zenn.dev/topics/cloudflare/feed'
const FIRST = 'https://zenn.dev/example/articles/feed-collect'
const SECOND = 'https://zenn.dev/example/articles/durable-intro'

type ListedItem = {
  readonly id: string
  readonly listingState: string
  readonly fullTextState: string
  readonly recommendation: { readonly status: string; readonly grade: string | null }
}

function app(apiKey: string) {
  const store = createMemoryStore()
  const candidateStore = createMemoryCandidateStore()
  const sourceStore = createMemoryFeedSourceStore()
  const queue = createFakeQueue()
  const feedQueue = createFakeFeedQueue()
  const hono = createApp({ store, queue, feedQueue, candidateStore, sourceStore })
  const env = {
    ...TEST_BINDINGS,
    OPENROUTER_API_KEY: apiKey,
    CLIP_QUEUE: queue,
    FEED_QUEUE: feedQueue,
  } as Cloudflare.Env
  return { hono, candidateStore, sourceStore, queue, feedQueue, env }
}

const headers = {
  'content-type': 'application/json',
  authorization: bearerAuthorization(),
}

function successfulEvaluate(grade = 'recommended', confidence = 0.92): EvaluateSystemOne {
  return async (request) => {
    const state = request.state as { excerpt?: string }
    expect(state.excerpt?.length ?? 0).toBeGreaterThan(0)
    return {
      ok: true,
      value: {
        model: 'jev-1.13.0',
        answers: {
          recommendation: {
            type: 'choice',
            choice: grade,
            confidence,
            probabilities: { [grade]: confidence },
          },
          de_relevant: { type: 'noul', noul: 0.91 },
          has_concreteness: { type: 'noul', noul: 0.8 },
          has_verification: { type: 'noul', noul: 0.7 },
        },
        usage: { inputTokens: 300, outputTokens: 16 },
      },
    }
  }
}

async function listedItems(ctx: ReturnType<typeof app>): Promise<ListedItem[]> {
  const listed = await ctx.hono.request(
    '/candidates.json',
    { headers: { authorization: bearerAuthorization() } },
    ctx.env,
  )
  expect(listed.status).toBe(200)
  const body = (await listed.json()) as { groups: { items: ListedItem[] }[] }
  return body.groups.flatMap((group) => group.items)
}

async function createAndCollect(
  ctx: ReturnType<typeof app>,
  evaluate: EvaluateSystemOne,
): Promise<void> {
  const created = await ctx.hono.request(
    '/sources',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Zenn Cloudflare',
        siteUrl: 'https://zenn.dev/topics/cloudflare',
        feedUrl: FEED,
        sourceType: 'posting_site',
      }),
    },
    ctx.env,
  )
  expect(created.status).toBe(201)
  const id = ((await created.json()) as { id: string }).id
  const collect = await ctx.hono.request(`/sources/${id}/collect`, { method: 'POST', headers }, ctx.env)
  expect(collect.status).toBe(202)
  await ctx.feedQueue.drain(ctx.env, {
    sourceStore: ctx.sourceStore,
    candidateStore: ctx.candidateStore,
    evaluateRecommend: evaluate,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('feed collection recommendation fixture e2e', () => {
  function installFeed(pages: Record<string, string>): void {
    installNetworkMock({
      pages: {
        [FEED]: { html: fixture('zenn-topic-feed.xml'), contentType: 'application/rss+xml' },
        [FIRST]: { html: pages[FIRST] ?? articleHtml(FIRST, 'Workers で RSS を読む') },
        [SECOND]: { html: pages[SECOND] ?? articleHtml(SECOND, 'Durable Objects 入門') },
      },
    })
  }

  it('makes zero Jev calls when the key is missing and does not leave body text unevaluated', async () => {
    installFeed({})
    let calls = 0
    const evaluate: EvaluateSystemOne = async () => {
      calls += 1
      throw new Error('evaluate should not run')
    }
    const ctx = app('')
    await createAndCollect(ctx, evaluate)
    expect(calls).toBe(0)
    const items = await listedItems(ctx)
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.recommendation.status).sort()).toEqual(['skipped', 'skipped'])
    expect(items.every((item) => item.listingState === 'listed' && item.recommendation.grade === null)).toBe(true)
    const page = await ctx.hono.request('/candidates', { headers: { authorization: bearerAuthorization() } }, ctx.env)
    expect(await page.text()).toContain('判定する')
  })

  it('marks short extracts as insufficient material without calling Jev', async () => {
    const short = fixture('too-short.html')
    installFeed({ [FIRST]: short, [SECOND]: short })
    let calls = 0
    const evaluate: EvaluateSystemOne = async () => {
      calls += 1
      throw new Error('evaluate should not run')
    }
    const ctx = app('or-test')
    await createAndCollect(ctx, evaluate)
    expect(calls).toBe(0)
    const items = await listedItems(ctx)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.recommendation.status === 'insufficient_material')).toBe(true)
    expect(items.every((item) => item.listingState === 'listed' && item.recommendation.grade === null)).toBe(true)
    const page = await ctx.hono.request('/candidates', { headers: { authorization: bearerAuthorization() } }, ctx.env)
    expect(await page.text()).toContain('判定する')
  })

  it('evaluates extracted feed text and keeps full-text delivery available', async () => {
    installFeed({})
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, deps) => {
      calls += 1
      return successfulEvaluate()(request, deps)
    }
    const ctx = app('or-test')
    await createAndCollect(ctx, evaluate)
    expect(calls).toBe(2)
    const items = await listedItems(ctx)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.recommendation.status === 'evaluated')).toBe(true)
    expect(items.every((item) => item.recommendation.grade === 'recommended')).toBe(true)
    expect(items.every((item) => item.listingState === 'listed' && item.fullTextState === 'confirmed_free')).toBe(true)
    const page = await ctx.hono.request('/candidates', { headers: { authorization: bearerAuthorization() } }, ctx.env)
    const html = await page.text()
    expect(html).toContain('再判定')
    expect(html).toContain('全文を送る')
    expect(ctx.queue.size).toBe(0)
  })

  it('keeps a failed judgment listed and still accepts full-text delivery', async () => {
    installFeed({})
    let calls = 0
    const evaluate: EvaluateSystemOne = async () => {
      calls += 1
      return { ok: false, error: { kind: 'jev_failed', code: 'timeout', reason: 'deadline' } }
    }
    const ctx = app('or-test')
    await createAndCollect(ctx, evaluate)
    expect(calls).toBe(2)
    const items = await listedItems(ctx)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.recommendation.status === 'failed' && item.recommendation.grade === null)).toBe(
      true,
    )
    expect(items.every((item) => item.listingState === 'listed' && item.fullTextState === 'confirmed_free')).toBe(true)
    const page = await ctx.hono.request('/candidates', { headers: { authorization: bearerAuthorization() } }, ctx.env)
    const html = await page.text()
    expect(html).toContain('判定する')
    expect(html).toContain('全文を送る')
    const first = items[0]
    expect(first).toBeDefined()
    const sent = await ctx.hono.request(
      `/candidates/${first?.id}/clip`,
      { method: 'POST', headers, body: '{}' },
      ctx.env,
    )
    expect(sent.status).toBe(202)
    expect(((await sent.json()) as { deliveryState: string }).deliveryState).toBe('preparing')
    expect(ctx.queue.size).toBe(1)
  })

  it('does not call Jev again when a later collection sees the same excerpt', async () => {
    installFeed({})
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, deps) => {
      calls += 1
      return successfulEvaluate()(request, deps)
    }
    const ctx = app('or-test')
    await createAndCollect(ctx, evaluate)
    expect(calls).toBe(2)

    const sources = await ctx.hono.request(
      '/sources.json',
      { headers: { authorization: bearerAuthorization() } },
      ctx.env,
    )
    const sourceId = ((await sources.json()) as { sources: { id: string }[] }).sources[0]?.id
    expect(sourceId).toBeDefined()
    const again = await ctx.hono.request(`/sources/${sourceId}/collect`, { method: 'POST', headers }, ctx.env)
    expect(again.status).toBe(202)
    await ctx.feedQueue.drain(ctx.env, {
      sourceStore: ctx.sourceStore,
      candidateStore: ctx.candidateStore,
      evaluateRecommend: evaluate,
    })
    expect(calls).toBe(2)
    const items = await listedItems(ctx)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.recommendation.status === 'evaluated')).toBe(true)
    expect(items.every((item) => item.recommendation.grade === 'recommended')).toBe(true)
  })
})
