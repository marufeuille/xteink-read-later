import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { compareDailyIdentities, dailyDateFromInstant, dailyIssueIdentity, isDailyCanonicalUrl, parseDailyDate } from '../src/daily/identity'
import { buildDummyDailyWrite } from '../src/daily/issue'
import { publishLatestDaily } from '../src/daily/publish'
import { buildOpdsCatalog, OPDS_CACHE_CONTROL } from '../src/opds/catalog'
import { createApp } from '../src/app'
import { createMemoryStore } from '../src/store/memory'
import { unavailableClassification } from '../src/classify/taxonomy'
import {
  asArticleId,
  articleIdFromCanonicalUrl,
  asEpubBytes,
  DAILY_IDENTITY_STRATEGY,
  parseHttpUrl,
  type ArticleWrite,
  type HttpUrl,
} from '../src/types'
import { basicAuthorization, TEST_BINDINGS } from './bindings'

const ORIGIN = mustUrl('https://read.example.com')
const DAY1 = '2026-09-20'
const DAY2 = '2026-09-21'

function mustUrl(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function epubIdentifier(epub: Uint8Array): string {
  const files = unzipSync(epub)
  const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
  return /<dc:identifier[^>]*>([^<]+)<\/dc:identifier>/.exec(opf)?.[1] ?? ''
}

function epubChapter(epub: Uint8Array): string {
  const files = unzipSync(epub)
  return strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
}

function parseOpdsEntries(xml: string): readonly {
  readonly id: string
  readonly title: string
  readonly updated: string
  readonly acquisition: string
}[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1] ?? ''
    return {
      id: /<id>([^<]+)<\/id>/.exec(entry)?.[1] ?? '',
      title: /<title>([^<]+)<\/title>/.exec(entry)?.[1] ?? '',
      updated: /<updated>([^<]+)<\/updated>/.exec(entry)?.[1] ?? '',
      acquisition:
        /rel="http:\/\/opds-spec.org\/acquisition"[^>]*href="([^"]+)"/.exec(entry)?.[1] ?? '',
    }
  })
}

function clipArticle(title: string): ArticleWrite {
  return {
    id: asArticleId('art_cccccccccccccccccccccccccccccccc'),
    title,
    author: null,
    publishedAt: null,
    sourceUrl: mustUrl('https://example.com/clip'),
    canonicalUrl: mustUrl('https://example.com/clip'),
    language: 'ja',
    translated: false,
    classification: unavailableClassification('skipped'),
    epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7])),
  }
}

describe('daily identity', () => {
  it('uses a new OPDS entry, URL, EPUB identifier, and filename per JST day', async () => {
    expect(DAILY_IDENTITY_STRATEGY).toBe('new-id-per-jst-day')
    expect(parseDailyDate('2026-02-31')).toBeNull()
    expect(dailyDateFromInstant(new Date('2026-09-20T14:59:59.000Z'))).toBe('2026-09-20')
    expect(dailyDateFromInstant(new Date('2026-09-20T15:00:00.000Z'))).toBe('2026-09-21')

    const day1 = await dailyIssueIdentity({ date: DAY1, origin: ORIGIN })
    const day2 = await dailyIssueIdentity({ date: DAY2, origin: ORIGIN })
    const sameDay = await dailyIssueIdentity({ date: DAY1, origin: ORIGIN })
    const nextDay = compareDailyIdentities(day1, day2)
    const same = compareDailyIdentities(day1, sameDay)

    expect(nextDay).toMatchObject({
      sameArticleId: false,
      sameOpdsEntryId: false,
      sameAcquisitionUrl: false,
      sameFilename: false,
      sameEpubIdentifier: false,
    })
    expect(same).toMatchObject({
      sameArticleId: true,
      sameOpdsEntryId: true,
      sameAcquisitionUrl: true,
      sameFilename: true,
      sameEpubIdentifier: true,
    })
    expect(day1.opdsEntryId).toBe(`https://read.example.com/articles/${day1.articleId}`)
    expect(day1.acquisitionUrl).toBe(`https://read.example.com/opds/download/${day1.articleId}.epub`)
    expect(day1.filename).toBe(`${day1.articleId}.epub`)
    expect(day1.epubIdentifier).toBe('urn:xteink:daily:2026-09-20')
    expect(day2.epubIdentifier).toBe('urn:xteink:daily:2026-09-21')
    expect(day1.title).toBe('まとめ 2026-09-20')
    expect(isDailyCanonicalUrl(day1.canonicalUrl)).toBe(true)
    expect(isDailyCanonicalUrl('https://example.com/clip')).toBe(false)
  })

  it('does not reuse a stable digest slot because next-day entry ID, URL, and filename would collide', async () => {
    const chosen = compareDailyIdentities(
      await dailyIssueIdentity({ date: DAY1, origin: ORIGIN }),
      await dailyIssueIdentity({ date: DAY2, origin: ORIGIN }),
    )
    expect(chosen.sameOpdsEntryId).toBe(false)
    expect(chosen.sameAcquisitionUrl).toBe(false)
    expect(chosen.sameFilename).toBe(false)

    const stableId = await articleIdFromCanonicalUrl(mustUrl('https://daily.invalid/digest/current'))
    const stableSlot = (_date: string) => ({
      opdsEntryId: `https://read.example.com/articles/${stableId}`,
      acquisitionUrl: `https://read.example.com/opds/download/${stableId}.epub`,
      filename: `${stableId}.epub`,
      epubIdentifier: 'urn:xteink:daily:current',
    })
    expect(stableSlot(DAY1)).toEqual(stableSlot(DAY2))
  })
})

describe('dummy daily EPUBs', () => {
  it('writes two days of digest EPUBs whose catalog fields all differ', async () => {
    const first = await buildDummyDailyWrite({ date: DAY1, origin: ORIGIN, bodyMarker: 'DAY-2026-09-20' })
    const second = await buildDummyDailyWrite({ date: DAY2, origin: ORIGIN, bodyMarker: 'DAY-2026-09-21' })
    const compared = compareDailyIdentities(first.identity, second.identity)
    expect(compared.sameArticleId).toBe(false)
    expect(compared.sameOpdsEntryId).toBe(false)
    expect(compared.sameAcquisitionUrl).toBe(false)
    expect(compared.sameFilename).toBe(false)
    expect(compared.sameEpubIdentifier).toBe(false)
    expect(epubIdentifier(first.write.epub)).toBe(first.identity.epubIdentifier)
    expect(epubIdentifier(second.write.epub)).toBe(second.identity.epubIdentifier)
    expect(epubChapter(first.write.epub)).toContain('DAY-2026-09-20')
    expect(epubChapter(second.write.epub)).toContain('DAY-2026-09-21')
    expect(epubChapter(second.write.epub)).not.toContain('DAY-2026-09-20')

    const store = createMemoryStore()
    await store.put(clipArticle('通常記事'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const publishedFirst = await publishLatestDaily(store, first.write)
    const firstCatalog = buildOpdsCatalog(await store.listMeta(), ORIGIN)
    const firstEntries = parseOpdsEntries(firstCatalog.xml)
    const firstDaily = firstEntries.find((entry) => entry.title === 'まとめ 2026-09-20')
    expect(firstEntries.map((entry) => entry.title).sort()).toEqual(['まとめ 2026-09-20', '通常記事'])
    expect(firstDaily?.id).toBe(first.identity.opdsEntryId)
    expect(firstDaily?.acquisition).toBe(first.identity.acquisitionUrl)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const publishedSecond = await publishLatestDaily(store, second.write)
    expect(publishedSecond.removedIds).toEqual([publishedFirst.meta.id])
    const listed = await store.listMeta()
    expect(listed.map((item) => item.title).sort()).toEqual(['まとめ 2026-09-21', '通常記事'])
    expect(listed.some((item) => item.id === first.identity.articleId)).toBe(false)

    const secondCatalog = buildOpdsCatalog(listed, ORIGIN)
    const secondEntries = parseOpdsEntries(secondCatalog.xml)
    const secondDaily = secondEntries.find((entry) => entry.title === 'まとめ 2026-09-21')
    expect(secondEntries).toHaveLength(2)
    expect(secondDaily?.id).toBe(second.identity.opdsEntryId)
    expect(secondDaily?.acquisition).toBe(second.identity.acquisitionUrl)
    expect(secondDaily?.updated).not.toBe(firstDaily?.updated)
    expect(secondCatalog.xml).not.toContain(first.identity.opdsEntryId)
    expect(secondCatalog.xml).not.toContain(first.identity.filename)
  })

  it('overwrites the same JST day instead of duplicating it', async () => {
    const store = createMemoryStore()
    const first = await buildDummyDailyWrite({ date: DAY1, origin: ORIGIN, bodyMarker: 'first' })
    await publishLatestDaily(store, first.write)
    const second = await buildDummyDailyWrite({ date: DAY1, origin: ORIGIN, bodyMarker: 'second' })
    const published = await publishLatestDaily(store, second.write)
    expect(published.removedIds).toEqual([])
    expect(published.meta.id).toBe(first.identity.articleId)
    const listed = await store.listMeta()
    expect(listed).toHaveLength(1)
    expect(epubChapter((await store.getEpub(first.identity.articleId)) ?? new Uint8Array())).toContain('second')
  })

  it('refuses to publish a non-daily article as the digest slot', async () => {
    const store = createMemoryStore()
    await expect(publishLatestDaily(store, clipArticle('通常記事'))).rejects.toThrow(
      'Not a daily digest canonical URL',
    )
    expect(await store.listMeta()).toEqual([])
  })
})

describe('daily OPDS HTTP', () => {
  it('serves only the latest daily digest and does not store catalog or EPUB', async () => {
    const store = createMemoryStore()
    const app = createApp({ store })
    const first = await buildDummyDailyWrite({ date: DAY1, origin: ORIGIN, bodyMarker: 'DAY-2026-09-20' })
    const second = await buildDummyDailyWrite({ date: DAY2, origin: ORIGIN, bodyMarker: 'DAY-2026-09-21' })
    await publishLatestDaily(store, first.write)
    await publishLatestDaily(store, second.write)

    const catalog = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(catalog.status).toBe(200)
    expect(catalog.headers.get('cache-control')).toBe(OPDS_CACHE_CONTROL)
    const xml = await catalog.text()
    expect(xml).toContain('まとめ 2026-09-21')
    expect(xml).not.toContain('まとめ 2026-09-20')
    expect(xml).toContain(second.identity.acquisitionUrl)

    const download = await app.request(
      second.identity.acquisitionUrl,
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('cache-control')).toBe(OPDS_CACHE_CONTROL)
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${second.identity.filename}"`)
    const epub = new Uint8Array(await download.arrayBuffer())
    expect(epubChapter(epub)).toContain('DAY-2026-09-21')
    expect(epubIdentifier(epub)).toBe('urn:xteink:daily:2026-09-21')
  })
})
