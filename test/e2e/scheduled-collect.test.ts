import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { runScheduledFeedCollection } from '../../src/feeds/schedule'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import { createMemoryStore } from '../../src/store/memory'
import { asFeedSourceId } from '../../src/types'
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scheduled feed collection fixture e2e', () => {
  it('collects enabled feeds from Cron without using the clip queue', async () => {
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
      },
    })
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const sourceStore = createMemoryFeedSourceStore()
    const queue = createFakeQueue()
    const feedQueue = createFakeFeedQueue()
    const hono = createApp({ store, queue, feedQueue, candidateStore, sourceStore })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue, FEED_QUEUE: feedQueue } as Cloudflare.Env
    const headers = {
      'content-type': 'application/json',
      authorization: bearerAuthorization(),
    }
    const createSource = async (body: Record<string, string>) => {
      const res = await hono.request('/sources', { method: 'POST', headers, body: JSON.stringify(body) }, env)
      expect(res.status).toBe(201)
      return ((await res.json()) as { id: string }).id
    }

    const zennId = await createSource({
      name: 'Zenn Cloudflare',
      siteUrl: 'https://zenn.dev/topics/cloudflare',
      feedUrl: 'https://zenn.dev/topics/cloudflare/feed',
      sourceType: 'posting_site',
    })
    const mercariId = await createSource({
      name: 'Mercari Engineering',
      siteUrl: 'https://engineering.mercari.com/blog/',
      feedUrl: 'https://engineering.mercari.com/blog/feed.xml',
      sourceType: 'corporate_blog',
    })
    const brokenId = await createSource({
      name: 'Broken',
      siteUrl: 'https://broken.example.com/',
      feedUrl: 'https://broken.example.com/feed.xml',
      sourceType: 'news',
    })

    const scheduled = await runScheduledFeedCollection(env, { sourceStore, feedQueue })
    expect(scheduled.queued).toBe(3)
    expect(scheduled.failed).toBe(0)
    expect(queue.size).toBe(0)

    await feedQueue.drain(env, { sourceStore, candidateStore })
    expect(queue.size).toBe(0)
    expect((await candidateStore.listListed({ limit: 10, offset: 0 })).total).toBe(3)
    expect((await sourceStore.getById(asFeedSourceId(zennId)))?.collectionStatus).toBe('ready')
    expect((await sourceStore.getById(asFeedSourceId(mercariId)))?.collectionStatus).toBe('ready')
    expect((await sourceStore.getById(asFeedSourceId(brokenId)))?.collectionStatus).toBe('failed')
  })
})
