import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runScheduledFeedCollection } from '../src/feeds/schedule'
import { createMemoryFeedSourceStore } from '../src/store/memory-sources'
import { FEED_COLLECT_CRON, asFeedSourceId, parseHttpUrl, type FeedSource, type HttpUrl } from '../src/types'
import { TEST_BINDINGS } from './bindings'
import { createFakeFeedQueue } from './fake-feed-queue'
import { createFakeQueue } from './fake-queue'

const root = dirname(fileURLToPath(import.meta.url))

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
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
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...partial,
  }
}

describe('scheduled feed collection', () => {
  it('keeps wrangler.jsonc on the same Daily Cron expression', () => {
    const wrangler = readFileSync(join(root, '..', 'wrangler.jsonc'), 'utf8')
    expect(wrangler).toContain(`"${FEED_COLLECT_CRON}"`)
  })

  it('enqueues enabled sources onto the feed queue and leaves the clip queue unused', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(
      source({
        id: asFeedSourceId('src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        name: 'Zenn',
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
    )
    await sourceStore.put(
      source({
        id: asFeedSourceId('src_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        name: 'Stopped',
        feedUrl: mustUrl('https://engineering.mercari.com/blog/feed.xml'),
        enabled: false,
      }),
    )
    const feedQueue = createFakeFeedQueue()
    const clipQueue = createFakeQueue()
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: clipQueue, FEED_QUEUE: feedQueue } as Cloudflare.Env

    const result = await runScheduledFeedCollection(env, { sourceStore })
    expect(result).toEqual({ cron: FEED_COLLECT_CRON, queued: 1, failed: 0 })
    expect(feedQueue.size).toBe(1)
    expect(clipQueue.size).toBe(0)
    expect((await sourceStore.listEnabled())[0]?.collectionStatus).toBe('queued')
  })
})
