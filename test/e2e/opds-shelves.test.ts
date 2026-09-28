import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { dailyCanonicalUrl, dailyIssueIdentity } from '../../src/daily/identity'
import { buildDummyDailyWrite } from '../../src/daily/issue'
import { publishLatestDaily } from '../../src/daily/publish'
import { OPDS_CACHE_CONTROL, OPDS_CATALOG_TYPE, OPDS_NAVIGATION_TYPE } from '../../src/opds/catalog'
import { classifiedClassification, unavailableClassification } from '../../src/classify/taxonomy'
import { createMemoryStore } from '../../src/store/memory'
import {
  asArticleId,
  asEpubBytes,
  parseHttpUrl,
  purchasedCanonicalUrl,
  type ArticleWrite,
  type HttpUrl,
} from '../../src/types'
import { basicAuthorization, TEST_BINDINGS } from '../bindings'

const ORIGIN = mustUrl('https://read.example.com')

function mustUrl(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function book(partial: Pick<ArticleWrite, 'id' | 'title'> & Partial<ArticleWrite>): ArticleWrite {
  return {
    author: '著者',
    publishedAt: null,
    sourceUrl: mustUrl(`https://example.com/${partial.id}`),
    canonicalUrl: mustUrl(`https://example.com/${partial.id}`),
    language: 'ja',
    translated: false,
    classification: unavailableClassification('skipped'),
    epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
    ...partial,
  }
}

function subsectionHrefs(xml: string): readonly string[] {
  return [...xml.matchAll(/<link\s+rel="subsection"\s+href="([^"]+)"/g)].map((match) => match[1] ?? '')
}

describe('OPDS date shelves', () => {
  it('walks clip and ebook by JST date, keeps the latest digest on the root, and hides empty folders', async () => {
    const store = createMemoryStore()
    const manual = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const feed = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const undated = asArticleId('art_cccccccccccccccccccccccccccccccc')
    const purchased = asArticleId('art_dddddddddddddddddddddddddddddddd')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-18T01:00:00.000Z'))
      await store.put(
        book({
          id: manual,
          title: '手動記事',
          publishedAt: '2026-09-20T14:59:59.000Z',
          canonicalUrl: mustUrl('https://example.com/manual'),
          sourceUrl: mustUrl('https://example.com/manual'),
        }),
      )
      await store.put(
        book({
          id: undated,
          title: '日付のない記事',
          publishedAt: '2024年3月',
          canonicalUrl: mustUrl('https://notes.example.com/free-form'),
          sourceUrl: mustUrl('https://notes.example.com/free-form'),
        }),
      )
      vi.setSystemTime(new Date('2026-09-22T01:00:00.000Z'))
      await store.put(
        book({
          id: feed,
          title: 'フィード記事',
          publishedAt: '2026-09-20T15:00:00.000Z',
          canonicalUrl: mustUrl('https://feeds.example.com/item'),
          sourceUrl: mustUrl('https://feeds.example.com/item'),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
    await store.put(
      book({
        id: purchased,
        title: '購入本',
        publishedAt: '2026-08-01T00:00:00.000Z',
        canonicalUrl: purchasedCanonicalUrl(purchased),
        sourceUrl: purchasedCanonicalUrl(purchased),
        epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 4, 5, 6])),
      }),
    )
    const yesterday = await buildDummyDailyWrite({
      date: '2026-09-20',
      origin: ORIGIN,
      bodyMarker: 'DAY-2026-09-20',
    })
    const today = await buildDummyDailyWrite({
      date: '2026-09-21',
      origin: ORIGIN,
      bodyMarker: 'DAY-2026-09-21',
    })
    await publishLatestDaily(store, yesterday.write)
    await publishLatestDaily(store, today.write)

    const app = createApp({ store })
    const headers = { authorization: basicAuthorization() }
    const root = await app.request('https://read.example.com/opds', { headers }, TEST_BINDINGS)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain(OPDS_NAVIGATION_TYPE)
    expect(root.headers.get('cache-control')).toBe(OPDS_CACHE_CONTROL)
    const rootXml = await root.text()
    const rootSlash = await app.request('https://read.example.com/opds/', { headers }, TEST_BINDINGS)
    expect(await rootSlash.text()).toBe(rootXml)
    expect(subsectionHrefs(rootXml)).toEqual([
      'https://read.example.com/opds/clip',
      'https://read.example.com/opds/ebook',
    ])
    expect(rootXml).toContain('まとめ 2026-09-21')
    expect(rootXml).toContain(today.identity.opdsEntryId)
    expect(rootXml).toContain(today.identity.acquisitionUrl)
    expect(rootXml).not.toContain('まとめ 2026-09-20')
    expect(rootXml).not.toContain(yesterday.identity.opdsEntryId)
    expect(rootXml).not.toContain('手動記事')
    expect(rootXml).not.toContain('フィード記事')
    expect(rootXml).not.toContain('購入本')
    expect(rootXml).not.toContain('日付のない記事')

    const clip = await app.request('https://read.example.com/opds/clip/', { headers }, TEST_BINDINGS)
    expect(clip.headers.get('content-type')).toContain(OPDS_NAVIGATION_TYPE)
    expect(subsectionHrefs(await clip.text())).toEqual([
      'https://read.example.com/opds/clip/2026-09-22',
      'https://read.example.com/opds/clip/2026-09-18',
    ])

    const clippedLater = await app.request('https://read.example.com/opds/clip/2026-09-22', { headers }, TEST_BINDINGS)
    expect(clippedLater.headers.get('content-type')).toContain(OPDS_CATALOG_TYPE)
    const clippedLaterXml = await clippedLater.text()
    expect(clippedLaterXml).toContain('フィード記事')
    expect(clippedLaterXml).toContain(`https://read.example.com/opds/download/${feed}.epub`)
    expect(clippedLaterXml).toContain('<published>2026-09-20T15:00:00.000Z</published>')
    expect(clippedLaterXml).not.toContain('手動記事')
    expect(clippedLaterXml).not.toContain('日付のない記事')
    expect(clippedLaterXml).not.toContain('購入本')
    expect(clippedLaterXml).not.toContain('まとめ')

    const clippedEarlier = await app.request(
      'https://read.example.com/opds/clip/2026-09-18/',
      { headers },
      TEST_BINDINGS,
    )
    const clippedEarlierXml = await clippedEarlier.text()
    expect(clippedEarlierXml).toContain('手動記事')
    expect(clippedEarlierXml).toContain('日付のない記事')
    expect(clippedEarlierXml).toContain('<published>2026-09-20T14:59:59.000Z</published>')
    expect(clippedEarlierXml).not.toContain('フィード記事')
    expect(
      await app.request('https://read.example.com/opds/clip/2026-09-21', { headers }, TEST_BINDINGS),
    ).toMatchObject({ status: 404 })
    expect(
      await app.request('https://read.example.com/opds/clip/2026-09-20/', { headers }, TEST_BINDINGS),
    ).toMatchObject({ status: 404 })
    expect(await app.request('https://read.example.com/opds/clip/2026-01-01', { headers }, TEST_BINDINGS)).toMatchObject({
      status: 404,
    })

    const ebook = await app.request('https://read.example.com/opds/ebook', { headers }, TEST_BINDINGS)
    const ebookDates = subsectionHrefs(await ebook.text())
    expect(ebookDates).toEqual(['https://read.example.com/opds/ebook/2026-08-01'])
    const ebookDay = await app.request(ebookDates[0] ?? '', { headers }, TEST_BINDINGS)
    const ebookXml = await ebookDay.text()
    expect(ebookXml).toContain('購入本')
    expect(ebookXml).toContain(`https://read.example.com/opds/download/${purchased}.epub`)
    expect(ebookXml).not.toContain('手動記事')
    expect(ebookXml).not.toContain('フィード記事')
    expect(ebookXml).not.toContain('まとめ')

    const download = await app.request(today.identity.acquisitionUrl, { headers }, TEST_BINDINGS)
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${today.identity.filename}"`)
    const clipDownload = await app.request(
      `https://read.example.com/opds/download/${manual}.epub`,
      { headers },
      TEST_BINDINGS,
    )
    expect(clipDownload.headers.get('content-disposition')).toBe(`attachment; filename="${manual}.epub"`)
    const ebookDownload = await app.request(
      `https://read.example.com/opds/download/${purchased}.epub`,
      { headers },
      TEST_BINDINGS,
    )
    expect(ebookDownload.headers.get('content-disposition')).toBe(`attachment; filename="${purchased}.epub"`)
    expect(new Uint8Array(await ebookDownload.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 4, 5, 6]))

    const identity = await dailyIssueIdentity({ date: '2026-09-21', origin: ORIGIN })
    expect(today.identity.opdsEntryId).toBe(identity.opdsEntryId)
    expect(today.identity.acquisitionUrl).toBe(identity.acquisitionUrl)
    expect(today.identity.filename).toBe(identity.filename)
    expect(dailyCanonicalUrl('2026-09-21')).toBe(today.write.canonicalUrl)
  })

  it('moves a reclipped article onto the later JST day and leaves classification and untouched articles in place', async () => {
    const store = createMemoryStore()
    const id = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const stayed = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const write = book({
      id,
      title: '再クリップ',
      publishedAt: '2026-03-01T00:00:00.000Z',
      canonicalUrl: mustUrl('https://example.com/reclip'),
      sourceUrl: mustUrl('https://example.com/reclip'),
    })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'))
      await store.put(
        book({
          id: stayed,
          title: '動かさない記事',
          publishedAt: '2026-04-01T00:00:00.000Z',
        }),
      )
      await store.put(write)
      vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'))
      await store.put({ ...write, title: '同じ日' })
    } finally {
      vi.useRealTimers()
    }

    const app = createApp({ store })
    const headers = { authorization: basicAuthorization() }
    const sameDay = await app.request('https://read.example.com/opds/clip/2026-09-20', { headers }, TEST_BINDINGS)
    const sameDayXml = await sameDay.text()
    expect(sameDayXml.match(/<entry>/g)?.length).toBe(2)
    expect(sameDayXml).toContain('同じ日')
    expect(sameDayXml).toContain('動かさない記事')
    expect(sameDayXml).toContain('<published>2026-03-01T00:00:00.000Z</published>')
    expect(sameDayXml).not.toContain('まとめ')

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-20T15:00:00.000Z'))
      await store.put({ ...write, title: '翌日' })
      vi.setSystemTime(new Date('2026-09-22T03:00:00.000Z'))
      const classified = await store.putClassification(
        id,
        classifiedClassification({
          model: 'jev-1.13.0',
          durationMs: 90,
          inputTokens: 410,
          topic: 'tech',
          kind: 'explainer',
          topicConfidence: 0.94,
          kindConfidence: 0.91,
        }),
      )
      expect(classified?.createdAt).toBe('2026-09-20T10:00:00.000Z')
      expect(classified?.clippedAt).toBe('2026-09-20T15:00:00.000Z')
      expect(classified?.updatedAt).toBe('2026-09-22T03:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }

    const clip = await app.request('https://read.example.com/opds/clip', { headers }, TEST_BINDINGS)
    expect(subsectionHrefs(await clip.text())).toEqual([
      'https://read.example.com/opds/clip/2026-09-21',
      'https://read.example.com/opds/clip/2026-09-20',
    ])
    const oldDay = await app.request('https://read.example.com/opds/clip/2026-09-20', { headers }, TEST_BINDINGS)
    const oldXml = await oldDay.text()
    expect(oldXml.match(/<entry>/g)?.length).toBe(1)
    expect(oldXml).toContain('動かさない記事')
    expect(oldXml).toContain('<published>2026-04-01T00:00:00.000Z</published>')
    expect(oldXml).not.toContain('翌日')
    expect(oldXml).not.toContain('同じ日')
    const newDay = await app.request('https://read.example.com/opds/clip/2026-09-21', { headers }, TEST_BINDINGS)
    const newXml = await newDay.text()
    expect(newXml.match(/<entry>/g)?.length).toBe(1)
    expect(newXml).toContain('翌日')
    expect(newXml).toContain('<published>2026-03-01T00:00:00.000Z</published>')
    expect(
      await app.request('https://read.example.com/opds/clip/2026-09-22', { headers }, TEST_BINDINGS),
    ).toMatchObject({ status: 404 })
    expect(await app.request('https://read.example.com/opds/ebook', { headers }, TEST_BINDINGS)).toMatchObject({
      status: 404,
    })
  })
})
