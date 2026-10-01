import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import { createMemoryStore } from '../../src/store/memory'
import {
  asFeedRunId,
  asFeedSourceId,
  parseHttpUrl,
  type FeedSource,
  type HttpUrl,
} from '../../src/types'
import { bearerAuthorization, TEST_BINDINGS } from '../bindings'

const COLLECTED_AT = '2026-10-01T07:27:00.000Z'
const PREVIOUS_AT = '2026-09-30T00:00:00.000Z'

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

function card(page: string, name: string): string {
  const found = page
    .split('<article class="item">')
    .slice(1)
    .find((article) => article.includes(`<h2>${name}</h2>`))
  if (found === undefined) {
    throw new Error(`missing card ${name}`)
  }
  return found
}

describe('sources list last collected time', () => {
  it('renders JST collect times on the HTML list and leaves the JSON payload unchanged', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put(
      source({
        id: asFeedSourceId('src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        name: 'Ready zero',
        siteUrl: mustUrl('https://ready.example.com/'),
        feedUrl: mustUrl('https://ready.example.com/feed.xml'),
        collectionStatus: 'ready',
        collectionRunId: asFeedRunId('frun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        itemsSeen: 3,
        itemsRegistered: 0,
        itemsDuplicate: 2,
        itemsSkipped: 1,
        lastCollectedAt: COLLECTED_AT,
        createdAt: '2026-09-21T00:00:04.000Z',
      }),
    )
    await sourceStore.put(
      source({
        id: asFeedSourceId('src_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        name: 'Failed feed',
        siteUrl: mustUrl('https://failed.example.com/'),
        feedUrl: mustUrl('https://failed.example.com/feed.xml'),
        collectionStatus: 'failed',
        collectionRunId: asFeedRunId('frun_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        collectionErrorCode: 'invalid_feed',
        collectionErrorMessage: 'フィードを読めませんでした',
        lastCollectedAt: COLLECTED_AT,
        createdAt: '2026-09-21T00:00:03.000Z',
      }),
    )
    await sourceStore.put(
      source({
        id: asFeedSourceId('src_cccccccccccccccccccccccccccccccc'),
        name: 'Never collected',
        siteUrl: mustUrl('https://fresh.example.com/'),
        feedUrl: mustUrl('https://fresh.example.com/feed.xml'),
        createdAt: '2026-09-21T00:00:02.000Z',
      }),
    )
    await sourceStore.put(
      source({
        id: asFeedSourceId('src_dddddddddddddddddddddddddddddddd'),
        name: 'Queued again',
        siteUrl: mustUrl('https://queued.example.com/'),
        feedUrl: mustUrl('https://queued.example.com/feed.xml'),
        collectionStatus: 'queued',
        collectionRunId: asFeedRunId('frun_dddddddddddddddddddddddddddddddd'),
        itemsRegistered: 4,
        lastCollectedAt: PREVIOUS_AT,
        createdAt: '2026-09-21T00:00:01.000Z',
      }),
    )
    await sourceStore.put(
      source({
        id: asFeedSourceId('src_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        name: 'Running again',
        siteUrl: mustUrl('https://running.example.com/'),
        feedUrl: mustUrl('https://running.example.com/feed.xml'),
        collectionStatus: 'running',
        collectionRunId: asFeedRunId('frun_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        itemsRegistered: 4,
        lastCollectedAt: PREVIOUS_AT,
        createdAt: '2026-09-21T00:00:00.000Z',
      }),
    )

    const app = createApp({
      store: createMemoryStore(),
      candidateStore: createMemoryCandidateStore(),
      sourceStore,
    })
    const env = TEST_BINDINGS
    const headers = { authorization: bearerAuthorization() }

    const htmlResponse = await app.request('/sources', { headers }, env)
    expect(htmlResponse.status).toBe(200)
    expect(htmlResponse.headers.get('content-type')).toContain('text/html')
    const page = await htmlResponse.text()

    const ready = card(page, 'Ready zero')
    expect(ready).toContain('前回 新規0 / 重複2 / スキップ1')
    expect(ready).toContain('最終収集: 2026-10-01 16:27 JST')
    expect(ready).toContain('href="https://ready.example.com/"')
    expect(ready).toContain('href="https://ready.example.com/feed.xml"')

    const failed = card(page, 'Failed feed')
    expect(failed).toContain('失敗: フィードを読めませんでした')
    expect(failed).toContain('最終収集: 2026-10-01 16:27 JST')
    expect(failed).toContain('href="https://failed.example.com/feed.xml"')

    const fresh = card(page, 'Never collected')
    expect(fresh).toContain('まだ収集していません')
    expect(fresh).not.toContain('最終収集')
    expect(fresh).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(fresh).toContain('href="https://fresh.example.com/feed.xml"')

    const queued = card(page, 'Queued again')
    expect(queued).toContain('収集待ち')
    expect(queued).toContain('前回の収集: 2026-09-30 09:00 JST')
    expect(queued).not.toContain('最終収集')
    expect(queued).not.toContain('前回 新規4')

    const running = card(page, 'Running again')
    expect(running).toContain('収集中')
    expect(running).toContain('前回の収集: 2026-09-30 09:00 JST')
    expect(running).not.toContain('最終収集')

    const jsonResponse = await app.request('/sources.json', { headers }, env)
    expect(jsonResponse.status).toBe(200)
    const body = (await jsonResponse.json()) as {
      sources: {
        name: string
        lastCollectedAt: string | null
        collectionStatus: string | null
        collectionErrorMessage: string | null
        itemsRegistered: number
        itemsDuplicate: number
        itemsSkipped: number
        siteUrl: string
        feedUrl: string
      }[]
    }
    expect(body.sources.map((row) => row.name)).toEqual([
      'Ready zero',
      'Failed feed',
      'Never collected',
      'Queued again',
      'Running again',
    ])
    expect(body.sources.find((row) => row.name === 'Ready zero')).toMatchObject({
      lastCollectedAt: COLLECTED_AT,
      collectionStatus: 'ready',
      itemsRegistered: 0,
      itemsDuplicate: 2,
      itemsSkipped: 1,
      siteUrl: 'https://ready.example.com/',
      feedUrl: 'https://ready.example.com/feed.xml',
    })
    expect(body.sources.find((row) => row.name === 'Failed feed')).toMatchObject({
      lastCollectedAt: COLLECTED_AT,
      collectionStatus: 'failed',
      collectionErrorMessage: 'フィードを読めませんでした',
    })
    expect(body.sources.find((row) => row.name === 'Never collected')?.lastCollectedAt).toBeNull()
    expect(body.sources.find((row) => row.name === 'Queued again')?.lastCollectedAt).toBe(PREVIOUS_AT)
    expect(JSON.stringify(body)).not.toContain('最終収集')
    expect(JSON.stringify(body)).not.toContain('前回の収集')
    expect(JSON.stringify(body)).not.toContain('16:27')
  })
})
