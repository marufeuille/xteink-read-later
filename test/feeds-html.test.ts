import { describe, expect, it } from 'vitest'
import { formatCollectedAtJst, lastCollectedLabel, sourcesPageHtml } from '../src/feeds/html'
import { asFeedSourceId, parseHttpUrl, type FeedSourcePublic, type HttpUrl } from '../src/types'

const COLLECTED_AT = '2026-10-01T07:27:00.000Z'
const COLLECTED_LABEL = '最終収集: 2026-10-01 16:27 JST'
const PREVIOUS_LABEL = '前回の収集: 2026-10-01 16:27 JST'

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function source(partial: Partial<FeedSourcePublic> & Pick<FeedSourcePublic, 'id' | 'name'>): FeedSourcePublic {
  return {
    siteUrl: mustUrl('https://example.com/'),
    feedUrl: mustUrl('https://example.com/feed.xml'),
    sourceType: 'corporate_blog',
    topicTags: ['cloudflare'],
    enabled: true,
    collectionStatus: null,
    collectionErrorCode: null,
    collectionErrorMessage: null,
    itemsSeen: 0,
    itemsRegistered: 0,
    itemsDuplicate: 0,
    itemsSkipped: 0,
    lastCollectedAt: null,
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

describe('formatCollectedAtJst', () => {
  it('formats a UTC instant as Asia/Tokyo YYYY-MM-DD HH:mm', () => {
    expect(formatCollectedAtJst(COLLECTED_AT)).toBe('2026-10-01 16:27')
    expect(formatCollectedAtJst('2026-09-30T15:00:00.000Z')).toBe('2026-10-01 00:00')
    expect(formatCollectedAtJst('2026-10-01T14:59:00.000Z')).toBe('2026-10-01 23:59')
    expect(formatCollectedAtJst('2026-12-31T15:00:00.000Z')).toBe('2027-01-01 00:00')
  })

  it('returns null for a missing or unparseable timestamp', () => {
    expect(formatCollectedAtJst('')).toBeNull()
    expect(formatCollectedAtJst('not-a-date')).toBeNull()
  })
})

describe('lastCollectedLabel', () => {
  it('shows the saved time for ready and failed', () => {
    expect(lastCollectedLabel({ collectionStatus: 'ready', lastCollectedAt: COLLECTED_AT })).toBe(COLLECTED_LABEL)
    expect(lastCollectedLabel({ collectionStatus: 'failed', lastCollectedAt: COLLECTED_AT })).toBe(COLLECTED_LABEL)
  })

  it('does not invent a date when there is no usable timestamp', () => {
    expect(lastCollectedLabel({ collectionStatus: null, lastCollectedAt: null })).toBe('まだ収集していません')
    expect(lastCollectedLabel({ collectionStatus: 'ready', lastCollectedAt: null })).toBe('まだ収集していません')
    expect(lastCollectedLabel({ collectionStatus: 'failed', lastCollectedAt: 'not-a-date' })).toBe('まだ収集していません')
    expect(lastCollectedLabel({ collectionStatus: 'queued', lastCollectedAt: null })).toBe('まだ収集していません')
  })

  it('labels a stored time as the previous collect while queued or running', () => {
    expect(lastCollectedLabel({ collectionStatus: 'queued', lastCollectedAt: COLLECTED_AT })).toBe(PREVIOUS_LABEL)
    expect(lastCollectedLabel({ collectionStatus: 'running', lastCollectedAt: COLLECTED_AT })).toBe(PREVIOUS_LABEL)
    expect(lastCollectedLabel({ collectionStatus: 'queued', lastCollectedAt: COLLECTED_AT })).not.toContain('最終収集')
  })
})

describe('sourcesPageHtml last collected line', () => {
  const ready = source({
    id: asFeedSourceId('src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    name: 'Ready zero',
    siteUrl: mustUrl('https://ready.example.com/'),
    feedUrl: mustUrl('https://ready.example.com/feed.xml'),
    collectionStatus: 'ready',
    itemsSeen: 3,
    itemsRegistered: 0,
    itemsDuplicate: 2,
    itemsSkipped: 1,
    lastCollectedAt: COLLECTED_AT,
  })
  const failed = source({
    id: asFeedSourceId('src_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    name: 'Failed feed',
    siteUrl: mustUrl('https://failed.example.com/'),
    feedUrl: mustUrl('https://failed.example.com/feed.xml?x=1&y=2'),
    collectionStatus: 'failed',
    collectionErrorCode: 'invalid_feed',
    collectionErrorMessage: 'フィードを読めませんでした <detail>',
    lastCollectedAt: COLLECTED_AT,
  })
  const fresh = source({
    id: asFeedSourceId('src_cccccccccccccccccccccccccccccccc'),
    name: 'Never collected',
    siteUrl: mustUrl('https://fresh.example.com/'),
    feedUrl: mustUrl('https://fresh.example.com/feed.xml'),
  })
  const queued = source({
    id: asFeedSourceId('src_dddddddddddddddddddddddddddddddd'),
    name: 'Queued again',
    siteUrl: mustUrl('https://queued.example.com/'),
    feedUrl: mustUrl('https://queued.example.com/feed.xml'),
    collectionStatus: 'queued',
    itemsRegistered: 4,
    lastCollectedAt: '2026-09-30T00:00:00.000Z',
  })
  const running = source({
    id: asFeedSourceId('src_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
    name: 'Running again',
    siteUrl: mustUrl('https://running.example.com/'),
    feedUrl: mustUrl('https://running.example.com/feed.xml'),
    collectionStatus: 'running',
    itemsRegistered: 4,
    lastCollectedAt: '2026-09-30T00:00:00.000Z',
  })
  const page = sourcesPageHtml({
    sources: [ready, failed, fresh, queued, running],
    csrfToken: 'csrf-token',
  })

  it('shows the JST time next to a ready count, including zero new items', () => {
    const article = card(page, 'Ready zero')
    expect(article).toContain('前回 新規0 / 重複2 / スキップ1')
    expect(article).toContain(COLLECTED_LABEL)
    expect(article).toContain('href="https://ready.example.com/"')
    expect(article).toContain('href="https://ready.example.com/feed.xml"')
  })

  it('keeps the failure text and URLs, and shows the saved time', () => {
    const article = card(page, 'Failed feed')
    expect(article).toContain('失敗: フィードを読めませんでした &lt;detail&gt;')
    expect(article).toContain(COLLECTED_LABEL)
    expect(article).toContain('href="https://failed.example.com/"')
    expect(article).toContain('href="https://failed.example.com/feed.xml?x=1&amp;y=2"')
  })

  it('shows that a source has never been collected, without a date', () => {
    const article = card(page, 'Never collected')
    expect(article).toContain('まだ収集していません')
    expect(article.split('まだ収集していません')).toHaveLength(2)
    expect(article).not.toContain('最終収集')
    expect(article).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(article).toContain('href="https://fresh.example.com/"')
    expect(article).toContain('href="https://fresh.example.com/feed.xml"')
  })

  it('does not present an older timestamp as the latest result while queued or running', () => {
    const queuedCard = card(page, 'Queued again')
    expect(queuedCard).toContain('収集待ち')
    expect(queuedCard).toContain('前回の収集: 2026-09-30 09:00 JST')
    expect(queuedCard).not.toContain('最終収集')
    expect(queuedCard).not.toContain('前回 新規4')
    expect(queuedCard).toContain('href="https://queued.example.com/feed.xml"')

    const runningCard = card(page, 'Running again')
    expect(runningCard).toContain('収集中')
    expect(runningCard).toContain('前回の収集: 2026-09-30 09:00 JST')
    expect(runningCard).not.toContain('最終収集')
    expect(runningCard).toContain('href="https://running.example.com/feed.xml"')
  })

  it('says a collection has not happened yet when the saved timestamp is unusable', () => {
    const broken = sourcesPageHtml({
      sources: [
        source({
          id: asFeedSourceId('src_ffffffffffffffffffffffffffffffff'),
          name: 'Bad stamp',
          collectionStatus: 'ready',
          itemsRegistered: 0,
          itemsDuplicate: 1,
          itemsSkipped: 0,
          lastCollectedAt: 'not-a-date',
        }),
      ],
      csrfToken: 'csrf-token',
    })
    const article = card(broken, 'Bad stamp')
    expect(article).toContain('前回 新規0 / 重複1 / スキップ0')
    expect(article).toContain('まだ収集していません')
    expect(article).not.toContain('最終収集')
    expect(article).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
})
