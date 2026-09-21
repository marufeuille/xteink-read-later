import { describe, expect, it } from 'vitest'
import { enqueueCollection, enqueueEnabledCollections } from '../src/feeds/enqueue'
import { createMemoryFeedSourceStore } from '../src/store/memory-sources'
import {
  asFeedRunId,
  asFeedSourceId,
  parseHttpUrl,
  type FeedSource,
  type HttpUrl,
} from '../src/types'
import { createFakeFeedQueue } from './fake-feed-queue'

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
    sourceType: 'posting_site',
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

const ENABLED = asFeedSourceId('src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const DISABLED = asFeedSourceId('src_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const BROKEN = asFeedSourceId('src_cccccccccccccccccccccccccccccccc')
const ACTIVE_RUN = asFeedRunId('frun_dddddddddddddddddddddddddddddddd')

describe('enqueue feed collection', () => {
  it('queues enabled sources, skips stopped ones, and isolates queue failures', async () => {
    const store = createMemoryFeedSourceStore()
    await store.put(
      source({
        id: ENABLED,
        name: 'Enabled',
        feedUrl: mustUrl('https://example.com/enabled.xml'),
      }),
    )
    await store.put(
      source({
        id: DISABLED,
        name: 'Stopped',
        feedUrl: mustUrl('https://example.com/stopped.xml'),
        enabled: false,
      }),
    )
    await store.put(
      source({
        id: BROKEN,
        name: 'Broken queue',
        feedUrl: mustUrl('https://example.com/broken.xml'),
      }),
    )
    const feedQueue = createFakeFeedQueue({
      onSend: (message) => {
        if (message.sourceId === BROKEN) {
          throw new Error('queue send failed')
        }
      },
    })
    const now = () => new Date('2026-09-21T19:00:00.000Z')

    const result = await enqueueEnabledCollections({ store, queue: feedQueue, now })
    expect(result.runs.map((run) => run.sourceId)).toEqual([ENABLED])
    expect(result.failures).toEqual([
      { sourceId: BROKEN, error: { kind: 'queue_failed', reason: 'queue send failed' } },
    ])
    expect(feedQueue.peek().map((message) => message.sourceId)).toEqual([ENABLED])
    expect((await store.getById(DISABLED))?.collectionStatus).toBeNull()
    expect((await store.getById(BROKEN))?.collectionStatus).toBe('failed')
    expect((await store.getById(ENABLED))?.collectionStatus).toBe('queued')
  })

  it('reuses an in-flight collection instead of enqueueing a second run', async () => {
    const store = createMemoryFeedSourceStore()
    await store.put(
      source({
        id: ENABLED,
        name: 'Active',
        feedUrl: mustUrl('https://example.com/active.xml'),
        collectionRunId: ACTIVE_RUN,
        collectionStatus: 'queued',
        updatedAt: '2026-09-21T19:00:00.000Z',
      }),
    )
    const feedQueue = createFakeFeedQueue()
    const queued = await enqueueCollection((await store.getById(ENABLED))!, {
      store,
      queue: feedQueue,
      now: () => new Date('2026-09-21T19:01:00.000Z'),
    })
    expect(queued.ok).toBe(true)
    if (queued.ok) {
      expect(queued.value.runId).toBe(ACTIVE_RUN)
    }
    expect(feedQueue.size).toBe(0)
  })

  it('rejects stopped sources', async () => {
    const store = createMemoryFeedSourceStore()
    const stopped = source({
      id: DISABLED,
      name: 'Stopped',
      feedUrl: mustUrl('https://example.com/stopped.xml'),
      enabled: false,
    })
    await store.put(stopped)
    const queued = await enqueueCollection(stopped, {
      store,
      queue: createFakeFeedQueue(),
      now: () => new Date(),
    })
    expect(queued).toEqual({ ok: false, error: { kind: 'source_disabled' } })
  })
})
