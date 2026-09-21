import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { buildDummyDailyWrite } from '../../src/daily/issue'
import { publishLatestDaily } from '../../src/daily/publish'
import { OPDS_CACHE_CONTROL } from '../../src/opds/catalog'
import { createMemoryStore } from '../../src/store/memory'
import { unavailableClassification } from '../../src/classify/taxonomy'
import { asArticleId, asEpubBytes, parseHttpUrl, type HttpUrl } from '../../src/types'
import { basicAuthorization, TEST_BINDINGS } from '../bindings'

function url(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function chapter(epub: Uint8Array): string {
  const files = unzipSync(epub)
  return strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
}

describe('daily OPDS fixture e2e', () => {
  it('replaces yesterday’s digest, keeps clipped articles, and shows today’s body', async () => {
    const store = createMemoryStore()
    const origin = url('https://read.example.com')
    await store.put({
      id: asArticleId('art_dddddddddddddddddddddddddddddddd'),
      title: 'クリップ記事',
      author: null,
      publishedAt: null,
      sourceUrl: url('https://example.com/kept'),
      canonicalUrl: url('https://example.com/kept'),
      language: 'ja',
      translated: false,
      classification: unavailableClassification('skipped'),
      epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
    })
    const day1 = await buildDummyDailyWrite({
      date: '2026-09-20',
      origin,
      bodyMarker: 'DAY-2026-09-20',
    })
    const day2 = await buildDummyDailyWrite({
      date: '2026-09-21',
      origin,
      bodyMarker: 'DAY-2026-09-21',
    })
    await publishLatestDaily(store, day1.write)
    await publishLatestDaily(store, day2.write)

    const app = createApp({ store })
    const catalog = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(catalog.status).toBe(200)
    expect(catalog.headers.get('cache-control')).toBe(OPDS_CACHE_CONTROL)
    const xml = await catalog.text()
    expect(xml).toContain('まとめ 2026-09-21')
    expect(xml).toContain('クリップ記事')
    expect(xml).not.toContain('まとめ 2026-09-20')
    expect(xml).toContain(day2.identity.opdsEntryId)
    expect(xml).toContain(day2.identity.acquisitionUrl)
    expect(xml).not.toContain(day1.identity.opdsEntryId)
    expect(xml).not.toContain(day1.identity.filename)

    const download = await app.request(
      day2.identity.acquisitionUrl,
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('cache-control')).toBe(OPDS_CACHE_CONTROL)
    expect(download.headers.get('content-disposition')).toBe(
      `attachment; filename="${day2.identity.filename}"`,
    )
    const epub = new Uint8Array(await download.arrayBuffer())
    const body = chapter(epub)
    expect(body).toContain('DAY-2026-09-21')
    expect(body).not.toContain('DAY-2026-09-20')
  })
})
