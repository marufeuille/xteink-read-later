import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { dailyCanonicalUrl } from '../src/daily/identity'
import {
  buildOpdsCatalog,
  OPDS_ACQUISITION_REL,
  OPDS_CATALOG_TYPE,
  OPDS_NAVIGATION_TYPE,
  OPDS_SUBSECTION_REL,
  opdsCalendarDate,
  parseOpdsCatalogPath,
  parseOpdsDownloadFile,
} from '../src/opds/catalog'
import { unavailableClassification } from '../src/classify/taxonomy'
import { createMemoryStore } from '../src/store/memory'
import {
  articleIdFromCanonicalUrl,
  asArticleId,
  asEpubBytes,
  parseHttpUrl,
  purchasedCanonicalUrl,
  type ArticleMeta,
  type ArticleWrite,
  type HttpUrl,
} from '../src/types'
import { basicAuthorization, TEST_BINDINGS } from './bindings'

const BINDINGS = TEST_BINDINGS

function url(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function article(partial: Pick<ArticleWrite, 'id' | 'title'> & Partial<ArticleWrite>): ArticleWrite {
  return {
    author: null,
    publishedAt: null,
    sourceUrl: url(`https://example.com/${partial.id}`),
    canonicalUrl: url(`https://example.com/${partial.id}`),
    language: 'ja',
    translated: false,
    classification: unavailableClassification('skipped'),
    epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7, 8, 9])),
    ...partial,
  }
}

function meta(
  partial: Pick<ArticleWrite, 'id' | 'title'> & Partial<ArticleWrite> & Pick<ArticleMeta, 'createdAt' | 'updatedAt'>,
): ArticleMeta {
  const written = article(partial)
  return {
    id: written.id,
    title: written.title,
    author: written.author,
    publishedAt: written.publishedAt,
    sourceUrl: written.sourceUrl,
    canonicalUrl: written.canonicalUrl,
    language: written.language,
    translated: written.translated,
    classification: written.classification ?? unavailableClassification('skipped'),
    createdAt: partial.createdAt,
    updatedAt: partial.updatedAt,
  }
}

function catalogXml(
  articles: readonly ArticleMeta[],
  location: Parameters<typeof buildOpdsCatalog>[2],
): string {
  const catalog = buildOpdsCatalog(articles, url('https://opds.example.com'), location)
  if (catalog === null) {
    throw new Error('missing catalog')
  }
  return catalog.xml
}

function subsectionHrefs(xml: string): readonly string[] {
  return [...xml.matchAll(/<link\s+rel="subsection"\s+href="([^"]+)"/g)].map((match) => match[1] ?? '')
}

describe('parseOpdsCatalogPath', () => {
  it('accepts the root, shelves, and valid dates with or without a trailing slash', () => {
    expect(parseOpdsCatalogPath('/opds')).toEqual({ kind: 'root' })
    expect(parseOpdsCatalogPath('/opds/')).toEqual({ kind: 'root' })
    expect(parseOpdsCatalogPath('/opds/clip')).toEqual({ kind: 'shelf', shelf: 'clip' })
    expect(parseOpdsCatalogPath('/opds/ebook/')).toEqual({ kind: 'shelf', shelf: 'ebook' })
    expect(parseOpdsCatalogPath('/opds/clip/2026-09-21')).toEqual({
      kind: 'date',
      shelf: 'clip',
      date: '2026-09-21',
    })
    expect(parseOpdsCatalogPath('/opds/ebook/2026-09-21/')).toEqual({
      kind: 'date',
      shelf: 'ebook',
      date: '2026-09-21',
    })
    expect(parseOpdsCatalogPath('/opds/clip/2026-02-31')).toBeNull()
    expect(parseOpdsCatalogPath('/opds/topic')).toBeNull()
    expect(parseOpdsCatalogPath('/opds/download/art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.epub')).toBeNull()
  })
})

describe('opdsCalendarDate', () => {
  it('uses the JST calendar date of publishedAt and falls back to createdAt', () => {
    const createdAt = '2026-09-20T15:00:00.000Z'
    const base = {
      createdAt,
      publishedAt: null as string | null,
    }
    expect(opdsCalendarDate({ ...base, publishedAt: '2026-09-20T14:59:59.000Z' })).toBe('2026-09-20')
    expect(opdsCalendarDate({ ...base, publishedAt: '2026-09-20T15:00:00.000Z' })).toBe('2026-09-21')
    expect(opdsCalendarDate({ ...base, publishedAt: '2026-09-21T00:00:00.000+09:00' })).toBe('2026-09-21')
    expect(opdsCalendarDate({ ...base, publishedAt: '2026-04-12' })).toBe('2026-04-12')
    expect(opdsCalendarDate({ ...base, publishedAt: '  2026-04-12  ' })).toBe('2026-04-12')
    expect(opdsCalendarDate({ ...base, publishedAt: null })).toBe('2026-09-21')
    expect(opdsCalendarDate({ ...base, publishedAt: '' })).toBe('2026-09-21')
    expect(opdsCalendarDate({ ...base, publishedAt: '   ' })).toBe('2026-09-21')
    expect(opdsCalendarDate({ ...base, publishedAt: '2024年3月' })).toBe('2026-09-21')
    expect(opdsCalendarDate({ ...base, publishedAt: '2026-02-31' })).toBe('2026-09-21')
    expect(
      opdsCalendarDate({ publishedAt: '2026-09-21T00:00:00', createdAt: '2026-09-18T00:00:00.000Z' }),
    ).toBe('2026-09-18')
    expect(opdsCalendarDate({ publishedAt: 'not-a-date', createdAt: 'also-not-a-date' })).toBeNull()
  })
})

describe('buildOpdsCatalog', () => {
  const origin = url('https://opds.example.com/')
  const manual = meta({
    id: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    title: '手動 & <記事>',
    author: '石井',
    publishedAt: '2026-09-19T15:00:00.000Z',
    sourceUrl: url('https://example.com/manual'),
    canonicalUrl: url('https://example.com/manual'),
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-21T01:00:00.000Z',
  })
  const feed = meta({
    id: asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    title: 'フィード記事',
    publishedAt: '2026-09-21T00:00:00.000Z',
    sourceUrl: url('https://feeds.example.com/item'),
    canonicalUrl: url('https://feeds.example.com/item'),
    createdAt: '2026-09-18T11:00:00.000Z',
    updatedAt: '2026-09-21T03:00:00.000Z',
  })
  const olderSameDay = meta({
    id: asArticleId('art_cccccccccccccccccccccccccccccccc'),
    title: '同じ日の古い記事',
    publishedAt: '2026-09-21T02:00:00.000Z',
    createdAt: '2026-09-18T12:00:00.000Z',
    updatedAt: '2026-09-21T02:00:00.000Z',
  })
  const purchasedId = asArticleId('art_dddddddddddddddddddddddddddddddd')
  const purchased = meta({
    id: purchasedId,
    title: '購入本',
    publishedAt: '2024年3月',
    sourceUrl: purchasedCanonicalUrl(purchasedId),
    canonicalUrl: purchasedCanonicalUrl(purchasedId),
    createdAt: '2026-09-20T14:59:59.000Z',
    updatedAt: '2026-09-20T14:59:59.000Z',
  })
  const readablePurchase = meta({
    id: asArticleId('art_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
    title: '日付のある購入本',
    publishedAt: '2026-09-21T00:00:00.000+09:00',
    sourceUrl: purchasedCanonicalUrl(asArticleId('art_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')),
    canonicalUrl: purchasedCanonicalUrl(asArticleId('art_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')),
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-21T04:00:00.000Z',
  })

  it('emits an empty navigation feed when nothing is published', () => {
    const catalog = buildOpdsCatalog([], url('https://opds.example.com'), { kind: 'root' })
    expect(catalog?.feedKind).toBe('navigation')
    const xml = catalog?.xml ?? ''
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"')
    expect(xml).toContain('<title>Xteink Read Later</title>')
    expect(xml).toContain('href="https://opds.example.com/opds"')
    expect(xml).toContain(`type="${OPDS_NAVIGATION_TYPE}"`)
    expect(xml).not.toContain('<entry>')
    expect(xml).not.toContain('/opds/clip')
    expect(xml).not.toContain('/opds/ebook')
  })

  it('puts web articles on clip and purchased books on ebook, newest date and entry first', () => {
    const articles = [olderSameDay, purchased, manual, feed, readablePurchase]
    const root = buildOpdsCatalog(articles, origin, { kind: 'root' })
    expect(root?.feedKind).toBe('navigation')
    const rootXml = root?.xml ?? ''
    expect(subsectionHrefs(rootXml)).toEqual([
      'https://opds.example.com/opds/clip',
      'https://opds.example.com/opds/ebook',
    ])
    expect(rootXml.indexOf('>clip<')).toBeLessThan(rootXml.indexOf('>ebook<'))
    expect(rootXml).not.toContain('手動')
    expect(rootXml).not.toContain('購入本')
    expect(rootXml).not.toContain(OPDS_ACQUISITION_REL)

    const clip = buildOpdsCatalog(articles, origin, { kind: 'shelf', shelf: 'clip' })
    expect(clip?.feedKind).toBe('navigation')
    expect(subsectionHrefs(clip?.xml ?? '')).toEqual([
      'https://opds.example.com/opds/clip/2026-09-21',
      'https://opds.example.com/opds/clip/2026-09-20',
    ])
    expect(buildOpdsCatalog(articles, origin, { kind: 'date', shelf: 'clip', date: '2026-09-19' })).toBeNull()

    const day = catalogXml(articles, { kind: 'date', shelf: 'clip', date: '2026-09-21' })
    expect(day).toContain(`type="${OPDS_CATALOG_TYPE}"`)
    expect(day).toContain(`rel="${OPDS_ACQUISITION_REL}"`)
    const feedAt = day.indexOf('フィード記事')
    const olderAt = day.indexOf('同じ日の古い記事')
    const manualAt = day.indexOf('手動 &amp; &lt;記事&gt;')
    expect(feedAt).toBeGreaterThan(0)
    expect(olderAt).toBeGreaterThan(feedAt)
    expect(manualAt).toBe(-1)
    expect(day).toContain(`href="https://opds.example.com/opds/download/${feed.id}.epub"`)
    expect(day).not.toContain('手動 & <記事>')
    expect(day).not.toContain('購入本')

    const previous = catalogXml(articles, { kind: 'date', shelf: 'clip', date: '2026-09-20' })
    expect(previous).toContain('手動 &amp; &lt;記事&gt;')
    expect(previous).toContain('<name>石井</name>')
    expect(previous).toContain('<published>2026-09-19T15:00:00.000Z</published>')
    expect(previous).not.toContain('フィード記事')

    const ebook = buildOpdsCatalog(articles, origin, { kind: 'shelf', shelf: 'ebook' })
    expect(subsectionHrefs(ebook?.xml ?? '')).toEqual([
      'https://opds.example.com/opds/ebook/2026-09-21',
      'https://opds.example.com/opds/ebook/2026-09-20',
    ])
    const purchasedDay = catalogXml(articles, { kind: 'date', shelf: 'ebook', date: '2026-09-20' })
    expect(purchasedDay).toContain('購入本')
    expect(purchasedDay).toContain(`href="https://opds.example.com/opds/download/${purchased.id}.epub"`)
    expect(purchasedDay).not.toContain('日付のある購入本')
    expect(catalogXml(articles, { kind: 'date', shelf: 'ebook', date: '2026-09-21' })).toContain('日付のある購入本')
  })

  it('keeps only the latest digest on the root and out of the date shelves', async () => {
    const olderDailyId = await articleIdFromCanonicalUrl(dailyCanonicalUrl('2026-09-20'))
    const newerDailyId = await articleIdFromCanonicalUrl(dailyCanonicalUrl('2026-09-21'))
    const olderDaily = meta({
      id: olderDailyId,
      title: 'まとめ 2026-09-20',
      publishedAt: '2026-09-19T15:00:00.000Z',
      canonicalUrl: dailyCanonicalUrl('2026-09-20'),
      sourceUrl: dailyCanonicalUrl('2026-09-20'),
      createdAt: '2026-09-20T21:00:00.000Z',
      updatedAt: '2026-09-20T21:00:00.000Z',
    })
    const newerDaily = meta({
      id: newerDailyId,
      title: 'まとめ 2026-09-21',
      publishedAt: '2026-09-20T15:00:00.000Z',
      canonicalUrl: dailyCanonicalUrl('2026-09-21'),
      sourceUrl: dailyCanonicalUrl('2026-09-21'),
      createdAt: '2026-09-21T21:00:00.000Z',
      updatedAt: '2026-09-21T21:00:00.000Z',
    })
    const clip = meta({
      id: asArticleId('art_ffffffffffffffffffffffffffffffff'),
      title: '残す記事',
      publishedAt: null,
      createdAt: '2026-09-21T01:00:00.000Z',
      updatedAt: '2026-09-21T01:00:00.000Z',
    })
    const articles = [olderDaily, clip, newerDaily]
    const root = catalogXml(articles, { kind: 'root' })
    expect(root).toContain('まとめ 2026-09-21')
    expect(root).toContain(`href="https://opds.example.com/opds/download/${newerDailyId}.epub"`)
    expect(root).toContain(`https://opds.example.com/articles/${newerDailyId}`)
    expect(root).not.toContain('まとめ 2026-09-20')
    expect(root).not.toContain(olderDailyId)
    expect(root).not.toContain('残す記事')
    expect(subsectionHrefs(root)).toEqual(['https://opds.example.com/opds/clip'])
    expect(root).not.toContain('/opds/ebook')

    const clipShelf = catalogXml(articles, { kind: 'shelf', shelf: 'clip' })
    expect(clipShelf).not.toContain('まとめ')
    expect(catalogXml(articles, { kind: 'date', shelf: 'clip', date: '2026-09-21' })).toContain('残す記事')
    expect(buildOpdsCatalog(articles, origin, { kind: 'shelf', shelf: 'ebook' })).toBeNull()
    expect(buildOpdsCatalog([olderDaily, newerDaily], origin, { kind: 'shelf', shelf: 'clip' })).toBeNull()
  })

  it('omits an empty shelf when the other shelf has books', () => {
    const onlyClip = [
      meta({
        id: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        title: 'Webだけ',
        publishedAt: '2026-09-21T00:00:00.000Z',
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      }),
    ]
    const root = catalogXml(onlyClip, { kind: 'root' })
    expect(subsectionHrefs(root)).toEqual(['https://opds.example.com/opds/clip'])
    expect(buildOpdsCatalog(onlyClip, origin, { kind: 'shelf', shelf: 'ebook' })).toBeNull()
    expect(buildOpdsCatalog(onlyClip, origin, { kind: 'date', shelf: 'ebook', date: '2026-09-21' })).toBeNull()
    expect(buildOpdsCatalog(onlyClip, origin, { kind: 'date', shelf: 'clip', date: '2026-09-20' })).toBeNull()
  })
})

describe('parseOpdsDownloadFile', () => {
  it('accepts article EPUB filenames only', () => {
    expect(parseOpdsDownloadFile('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.epub')).toBe(
      'art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    expect(parseOpdsDownloadFile('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
    expect(parseOpdsDownloadFile('book.epub')).toBeNull()
  })
})

describe('OPDS HTTP', () => {
  it('serves navigation shelves and keeps the acquisition filename', async () => {
    const store = createMemoryStore()
    const older = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const newer = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const purchased = asArticleId('art_dddddddddddddddddddddddddddddddd')
    await store.put(
      article({
        id: older,
        title: '古い記事',
        publishedAt: '2026-09-20T00:00:00.000Z',
      }),
    )
    await store.put(
      article({
        id: newer,
        title: '新しい記事',
        publishedAt: '2026-09-21T00:00:00.000Z',
        epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
      }),
    )
    await store.put(
      article({
        id: purchased,
        title: '購入本',
        publishedAt: '自由な日付',
        canonicalUrl: purchasedCanonicalUrl(purchased),
        sourceUrl: purchasedCanonicalUrl(purchased),
      }),
    )
    const app = createApp({ store })
    const headers = { authorization: basicAuthorization() }
    const catalog = await app.request('https://read.example.com/opds', { headers }, BINDINGS)
    expect(catalog.status).toBe(200)
    expect(catalog.headers.get('content-type')).toContain(OPDS_NAVIGATION_TYPE)
    expect(catalog.headers.get('cache-control')).toBe('no-store')
    const xml = await catalog.text()
    expect(subsectionHrefs(xml)).toEqual([
      'https://read.example.com/opds/clip',
      'https://read.example.com/opds/ebook',
    ])
    expect(xml).not.toContain('新しい記事')
    expect(xml).not.toContain('購入本')

    const trailing = await app.request('https://read.example.com/opds/', { headers }, BINDINGS)
    expect(trailing.status).toBe(200)
    expect(trailing.headers.get('content-type')).toContain('kind=navigation')
    expect(subsectionHrefs(await trailing.text())).toEqual(subsectionHrefs(xml))

    const clip = await app.request('https://read.example.com/opds/clip/', { headers }, BINDINGS)
    expect(clip.status).toBe(200)
    expect(subsectionHrefs(await clip.text())).toEqual([
      'https://read.example.com/opds/clip/2026-09-21',
      'https://read.example.com/opds/clip/2026-09-20',
    ])

    const day = await app.request('https://read.example.com/opds/clip/2026-09-21', { headers }, BINDINGS)
    expect(day.status).toBe(200)
    expect(day.headers.get('content-type')).toContain(OPDS_CATALOG_TYPE)
    const dayXml = await day.text()
    expect(dayXml).toContain('新しい記事')
    expect(dayXml).not.toContain('古い記事')
    expect(dayXml).toContain(`https://read.example.com/opds/download/${newer}.epub`)

    const otherDay = await app.request('https://read.example.com/opds/clip/2026-09-20/', { headers }, BINDINGS)
    expect(await otherDay.text()).toContain('古い記事')

    const purchasedMeta = await app.request(`https://read.example.com/articles/${purchased}`, { headers }, BINDINGS)
    const createdAt = ((await purchasedMeta.json()) as { createdAt: string }).createdAt
    const purchasedDate = opdsCalendarDate({ publishedAt: '自由な日付', createdAt })
    expect(purchasedDate).not.toBeNull()
    const ebookDay = await app.request(
      `https://read.example.com/opds/ebook/${purchasedDate}`,
      { headers },
      BINDINGS,
    )
    expect(ebookDay.status).toBe(200)
    expect(await ebookDay.text()).toContain('購入本')

    const download = await app.request(
      `https://read.example.com/opds/download/${newer}.epub`,
      { headers },
      BINDINGS,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/epub+zip')
    expect(download.headers.get('cache-control')).toBe('no-store')
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${newer}.epub"`)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))

    const missing = await app.request(
      'https://read.example.com/opds/download/art_cccccccccccccccccccccccccccccccc.epub',
      { headers },
      BINDINGS,
    )
    expect(missing.status).toBe(404)
  })

  it('hides empty shelves and dates, and still rejects bad paths', async () => {
    const store = createMemoryStore()
    const app = createApp({ store })
    const headers = { authorization: basicAuthorization() }

    const empty = await app.request('https://read.example.com/opds', { headers }, BINDINGS)
    expect(empty.status).toBe(200)
    const emptyXml = await empty.text()
    expect(emptyXml).toContain('<title>Xteink Read Later</title>')
    expect(emptyXml).not.toContain('<entry>')
    expect(emptyXml).not.toContain(OPDS_SUBSECTION_REL)

    const emptyShelf = await app.request('https://read.example.com/opds/clip', { headers }, BINDINGS)
    expect(emptyShelf.status).toBe(404)
    const emptyDate = await app.request('https://read.example.com/opds/ebook/2026-09-21', { headers }, BINDINGS)
    expect(emptyDate.status).toBe(404)
    const invalidDate = await app.request('https://read.example.com/opds/clip/2026-02-31', { headers }, BINDINGS)
    expect(invalidDate.status).toBe(404)

    const noAuth = await app.request('https://read.example.com/opds/clip', {}, BINDINGS)
    expect(noAuth.status).toBe(401)

    const noAuthDownload = await app.request(
      'https://read.example.com/opds/download/art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.epub',
      {},
      BINDINGS,
    )
    expect(noAuthDownload.status).toBe(401)

    const unknownPath = await app.request('https://read.example.com/opds/catalog', { headers }, BINDINGS)
    expect(unknownPath.status).toBe(404)

    const badFile = await app.request(
      'https://read.example.com/opds/download/not-an-id.epub',
      { headers },
      BINDINGS,
    )
    expect(badFile.status).toBe(404)
  })
})
