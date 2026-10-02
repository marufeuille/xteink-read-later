import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { asFeedSourceId, MAX_FEED_BYTES } from '../../src/types'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import { createMemoryStore } from '../../src/store/memory'
import { bearerAuthorization, TEST_BINDINGS } from '../bindings'
import { createFakeFeedQueue } from '../fake-feed-queue'
import { createFakeQueue } from '../fake-queue'
import { installNetworkMock } from './mock-network'

const FEED_URL = 'https://large.example.com/feed.xml'
const ARTICLE_URL = 'https://large.example.com/posts/1'
const TWO_MB_CLASS_BYTES = 2_100_000

function articleHtml(url: string, title: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><title>${title}</title><link rel="canonical" href="${url}" /></head>
<body><article><h1>${title}</h1><p>${title} の本文です。候補登録の抽出が通るだけの長さを持たせます。Cloudflare Workers。</p>
<p>二段落目も入れて最小文字数を超えます。</p></article></body></html>`
}

function largeRss(total: number): string {
  const prefix =
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Large</title><link>https://large.example.com/</link><item><title>Large post</title><link>https://large.example.com/posts/1</link><description>'
  const suffix = '</description></item></channel></rss>'
  return prefix + 'a'.repeat(total - prefix.length - suffix.length) + suffix
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('feed payload limit', () => {
  it('collects a ~2.1MB feed instead of failing as payload_too_large', async () => {
    expect(TWO_MB_CLASS_BYTES).toBeLessThanOrEqual(MAX_FEED_BYTES)
    const xml = largeRss(TWO_MB_CLASS_BYTES)
    expect(new TextEncoder().encode(xml).byteLength).toBe(TWO_MB_CLASS_BYTES)

    installNetworkMock({
      pages: {
        [FEED_URL]: { html: xml, contentType: 'application/rss+xml' },
        [ARTICLE_URL]: { html: articleHtml(ARTICLE_URL, 'Large post') },
      },
    })

    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const sourceStore = createMemoryFeedSourceStore()
    const queue = createFakeQueue()
    const feedQueue = createFakeFeedQueue()
    const hono = createApp({ store, queue, feedQueue, candidateStore, sourceStore })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue, FEED_QUEUE: feedQueue } as Cloudflare.Env
    const created = await hono.request(
      '/sources',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({
          name: 'Large feed',
          siteUrl: 'https://large.example.com/',
          feedUrl: FEED_URL,
          sourceType: 'corporate_blog',
        }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const sourceId = ((await created.json()) as { id: string }).id

    const collect = await hono.request(
      `/sources/${sourceId}/collect`,
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(),
          'content-type': 'application/json',
        },
      },
      env,
    )
    expect(collect.status).toBe(202)
    await feedQueue.drain(env, { sourceStore, candidateStore })

    const source = await sourceStore.getById(asFeedSourceId(sourceId))
    expect(source?.collectionStatus).toBe('ready')
    expect(source?.collectionErrorCode).toBeNull()
    expect(source?.itemsRegistered).toBe(1)
  })

  it('logs a numeric size when collection fails as payload_too_large', async () => {
    const feedUrl = 'https://oversized.example/feed.xml?token=super-secret-token'
    const declaredBytes = MAX_FEED_BYTES + 385_152
    installNetworkMock({
      pages: {
        [feedUrl]: {
          html: '<rss>raw body token=super-secret-token</rss>',
          contentType: 'application/rss+xml',
          headers: { 'content-length': String(declaredBytes) },
        },
      },
    })

    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const sourceStore = createMemoryFeedSourceStore()
    const queue = createFakeQueue()
    const feedQueue = createFakeFeedQueue()
    const hono = createApp({ store, queue, feedQueue, candidateStore, sourceStore })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue, FEED_QUEUE: feedQueue } as Cloudflare.Env
    const created = await hono.request(
      '/sources',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({
          name: 'Oversized feed',
          siteUrl: 'https://oversized.example/',
          feedUrl,
          sourceType: 'corporate_blog',
        }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const sourceId = ((await created.json()) as { id: string }).id

    const collect = await hono.request(
      `/sources/${sourceId}/collect`,
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(),
          'content-type': 'application/json',
        },
      },
      env,
    )
    expect(collect.status).toBe(202)

    const logs: Record<string, unknown>[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (typeof line === 'object' && line !== null) {
        logs.push(line as Record<string, unknown>)
      }
    })
    await feedQueue.drain(env, { sourceStore, candidateStore })

    const feedLogs = logs.filter((entry) => entry.event === 'feed')
    expect(feedLogs).toEqual([
      expect.objectContaining({
        message: 'feed collect payload_too_large',
        event: 'feed',
        errorKind: 'payload_too_large',
        bytes: declaredBytes,
        sourceId,
        hostname: 'oversized.example',
      }),
    ])
    const logged = feedLogs[0]
    expect(typeof logged?.bytes).toBe('number')
    expect(logged?.hostname).toBe('oversized.example')
    expect(logged).not.toHaveProperty('url')
    expect(logged).not.toHaveProperty('reason')
    expect(logged).not.toHaveProperty('body')
    const text = JSON.stringify(feedLogs)
    expect(text).not.toContain('https://oversized.example/feed.xml?token=super-secret-token')
    expect(text).not.toContain('/feed.xml')
    expect(text).not.toContain('?token=')
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('raw body')
    expect(text).not.toContain('Payload exceeded')
    expect(String(logged?.message)).toMatch(/^[A-Za-z0-9_ ]+$/)
    expect(String(logged?.message)).not.toContain('oversized.example')
    expect(String(logged?.message)).not.toContain(String(declaredBytes))

    const source = await sourceStore.getById(asFeedSourceId(sourceId))
    expect(source?.collectionStatus).toBe('failed')
    expect(source?.collectionErrorCode).toBe('payload_too_large')
  })
})
