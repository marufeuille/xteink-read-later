import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import { createMemoryStore } from '../../src/store/memory'
import { bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from '../bindings'
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

function app() {
  const store = createMemoryStore()
  const candidateStore = createMemoryCandidateStore()
  const sourceStore = createMemoryFeedSourceStore()
  const queue = createFakeQueue()
  const feedQueue = createFakeFeedQueue()
  const hono = createApp({ store, queue, feedQueue, candidateStore, sourceStore })
  const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue, FEED_QUEUE: feedQueue } as Cloudflare.Env
  return { hono, store, candidateStore, sourceStore, queue, feedQueue, env }
}

const headers = {
  'content-type': 'application/json',
  authorization: bearerAuthorization(),
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('source fixture e2e', () => {
  it('collects Zenn and Mercari feeds, isolates failures, and does not use the clip queue', async () => {
    installNetworkMock({
      pages: {
        'https://zenn.dev/topics/cloudflare/feed': {
          html: fixture('zenn-topic-feed.xml'),
          contentType: 'application/rss+xml',
        },
        'https://engineering.mercari.com/blog/feed.xml': {
          html: fixture('mercari-engineering-feed.xml'),
          contentType: 'application/atom+xml',
        },
        'https://broken.example.com/feed.xml': {
          html: fixture('invalid-feed.xml'),
          contentType: 'text/html',
        },
        'https://zenn.dev/example/articles/feed-collect': {
          html: articleHtml('https://zenn.dev/example/articles/feed-collect', 'Workers で RSS を読む'),
        },
        'https://zenn.dev/example/articles/durable-intro': {
          html: articleHtml('https://zenn.dev/example/articles/durable-intro', 'Durable Objects 入門'),
        },
        'https://engineering.mercari.com/blog/entry/2026-09-01-hello/': {
          html: articleHtml(
            'https://engineering.mercari.com/blog/entry/2026-09-01-hello/',
            'Hello from Mercari Engineering',
          ),
        },
        'https://silent.example.com/': {
          html: fixture('site-without-feed.html'),
        },
      },
    })
    const ctx = app()

    const zenn = await ctx.hono.request(
      '/sources',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Zenn Cloudflare',
          siteUrl: 'https://zenn.dev/topics/cloudflare',
          feedUrl: 'https://zenn.dev/topics/cloudflare/feed',
          sourceType: 'posting_site',
          topicTags: ['cloudflare'],
        }),
      },
      ctx.env,
    )
    expect(zenn.status).toBe(201)
    const zennId = ((await zenn.json()) as { id: string }).id

    const mercari = await ctx.hono.request(
      '/sources',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Mercari Engineering Blog',
          siteUrl: 'https://engineering.mercari.com/blog/',
          feedUrl: 'https://engineering.mercari.com/blog/feed.xml',
          sourceType: 'corporate_blog',
        }),
      },
      ctx.env,
    )
    expect(mercari.status).toBe(201)
    const mercariId = ((await mercari.json()) as { id: string }).id

    const broken = await ctx.hono.request(
      '/sources',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Broken',
          siteUrl: 'https://broken.example.com/',
          feedUrl: 'https://broken.example.com/feed.xml',
          sourceType: 'news',
        }),
      },
      ctx.env,
    )
    expect(broken.status).toBe(201)

    const missingFeed = await ctx.hono.request(
      '/sources',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Silent',
          siteUrl: 'https://silent.example.com/',
          sourceType: 'news',
        }),
      },
      ctx.env,
    )
    expect(missingFeed.status).toBe(400)

    const unauth = await ctx.hono.request('/sources.json', { headers: { accept: 'application/json' } }, ctx.env)
    expect(unauth.status).toBe(401)
    expect(await unauth.text()).not.toContain(TEST_CLIP_TOKEN)

    const collectAll = await ctx.hono.request('/sources/collect', { method: 'POST', headers }, ctx.env)
    expect(collectAll.status).toBe(202)
    await ctx.feedQueue.drain(ctx.env, {
      sourceStore: ctx.sourceStore,
      candidateStore: ctx.candidateStore,
    })

    const listed = await ctx.hono.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization() } },
      ctx.env,
    )
    const listBody = (await listed.json()) as { total: number }
    expect(listBody.total).toBe(3)

    const sources = await ctx.hono.request('/sources.json', { headers: { authorization: bearerAuthorization() } }, ctx.env)
    const sourceBody = (await sources.json()) as {
      sources: { id: string; collectionStatus: string; collectionErrorCode: string | null }[]
    }
    const brokenState = sourceBody.sources.find((row) => row.id !== zennId && row.id !== mercariId)
    expect(brokenState?.collectionStatus).toBe('failed')
    expect(brokenState?.collectionErrorCode).toBe('invalid_feed')
    expect(sourceBody.sources.find((row) => row.id === zennId)?.collectionStatus).toBe('ready')
    expect(sourceBody.sources.find((row) => row.id === mercariId)?.collectionStatus).toBe('ready')
    expect(ctx.queue.size).toBe(0)

    const manual = await ctx.hono.request(
      '/candidates',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: 'https://zenn.dev/example/articles/feed-collect' }),
      },
      ctx.env,
    )
    expect(manual.status).toBe(200)
    expect(((await manual.json()) as { duplicate: boolean }).duplicate).toBe(true)

    await ctx.hono.request(
      `/sources/${zennId}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Zenn Cloudflare',
          siteUrl: 'https://zenn.dev/topics/cloudflare',
          feedUrl: 'https://zenn.dev/topics/cloudflare/feed',
          sourceType: 'posting_site',
          enabled: false,
        }),
      },
      ctx.env,
    )
    const stoppedCollect = await ctx.hono.request(
      `/sources/${zennId}/collect`,
      { method: 'POST', headers },
      ctx.env,
    )
    expect(stoppedCollect.status).toBe(409)
    const afterStop = await ctx.hono.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization() } },
      ctx.env,
    )
    expect(((await afterStop.json()) as { total: number }).total).toBe(3)

    const retryBroken = await ctx.hono.request(
      `/sources/${brokenState?.id}/collect`,
      { method: 'POST', headers },
      ctx.env,
    )
    expect(retryBroken.status).toBe(202)
  })
})
