import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { dailyCanonicalUrl, dailyIssueIdentity } from '../../src/daily/identity'
import { buildDummyDailyWrite } from '../../src/daily/issue'
import { publishLatestDaily } from '../../src/daily/publish'
import { OPDS_CACHE_CONTROL, OPDS_CATALOG_TYPE, OPDS_NAVIGATION_TYPE, opdsCalendarDate } from '../../src/opds/catalog'
import { unavailableClassification } from '../../src/classify/taxonomy'
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
        id: feed,
        title: 'フィード記事',
        publishedAt: '2026-09-20T15:00:00.000Z',
        canonicalUrl: mustUrl('https://feeds.example.com/item'),
        sourceUrl: mustUrl('https://feeds.example.com/item'),
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
    const clipDates = subsectionHrefs(await clip.text())
    const undatedMeta = await app.request(`https://read.example.com/articles/${undated}`, { headers }, TEST_BINDINGS)
    const createdAt = ((await undatedMeta.json()) as { createdAt: string }).createdAt
    const fallbackDate = opdsCalendarDate({ publishedAt: '2024年3月', createdAt })
    expect(fallbackDate).not.toBeNull()
    expect(clipDates).toEqual(
      [...new Set(['2026-09-21', '2026-09-20', fallbackDate ?? ''])]
        .sort((left, right) => (left < right ? 1 : -1))
        .map((date) => `https://read.example.com/opds/clip/${date}`),
    )

    const sep21 = await app.request('https://read.example.com/opds/clip/2026-09-21', { headers }, TEST_BINDINGS)
    expect(sep21.headers.get('content-type')).toContain(OPDS_CATALOG_TYPE)
    const sep21Xml = await sep21.text()
    expect(sep21Xml).toContain('フィード記事')
    expect(sep21Xml).toContain(`https://read.example.com/opds/download/${feed}.epub`)
    expect(sep21Xml).not.toContain('手動記事')
    expect(sep21Xml).not.toContain('購入本')
    expect(sep21Xml).not.toContain('まとめ')
    expect(sep21Xml.includes('日付のない記事')).toBe(fallbackDate === '2026-09-21')

    const sep20 = await app.request('https://read.example.com/opds/clip/2026-09-20/', { headers }, TEST_BINDINGS)
    const sep20Xml = await sep20.text()
    expect(sep20Xml).toContain('手動記事')
    expect(sep20Xml).not.toContain('フィード記事')
    expect(sep20Xml.includes('日付のない記事')).toBe(fallbackDate === '2026-09-20')

    const fallback = await app.request(
      `https://read.example.com/opds/clip/${fallbackDate}`,
      { headers },
      TEST_BINDINGS,
    )
    const fallbackXml = await fallback.text()
    expect(fallbackXml).toContain('日付のない記事')
    expect(fallbackXml.includes('フィード記事')).toBe(fallbackDate === '2026-09-21')
    expect(fallbackXml.includes('手動記事')).toBe(fallbackDate === '2026-09-20')
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
})
