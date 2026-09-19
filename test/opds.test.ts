import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createExtractPipeline } from '../src/extract/pipeline'
import { buildOpdsCatalog, OPDS_ACQUISITION_REL, OPDS_CATALOG_TYPE, parseOpdsDownloadFile } from '../src/opds/catalog'
import { createClipPipeline } from '../src/pipeline/clip'
import { createMemoryStore } from '../src/store/memory'
import {
  asArticleId,
  asEpubBytes,
  ok,
  parseHttpUrl,
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
    epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7, 8, 9])),
    ...partial,
  }
}

describe('buildOpdsCatalog', () => {
  it('emits a valid empty acquisition feed', () => {
    const { xml } = buildOpdsCatalog([], url('https://opds.example.com'))
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"')
    expect(xml).toContain('<title>Xteink Read Later</title>')
    expect(xml).toContain('href="https://opds.example.com/opds"')
    expect(xml).toContain(`type="${OPDS_CATALOG_TYPE}"`)
    expect(xml).not.toContain('<entry>')
  })

  it('lists newest articles first and escapes titles', () => {
    const older = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const newer = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const { xml } = buildOpdsCatalog(
      [
        {
          ...article({ id: newer, title: '新しい & <上>' }),
          createdAt: '2026-09-19T10:00:00.000Z',
          updatedAt: '2026-09-19T12:00:00.000Z',
        },
        {
          ...article({
            id: older,
            title: '古い',
            author: '石井',
            publishedAt: '2026-03-01T00:00:00.000Z',
          }),
          createdAt: '2026-09-18T10:00:00.000Z',
          updatedAt: '2026-09-18T10:00:00.000Z',
        },
      ],
      url('https://opds.example.com/'),
    )
    const newerAt = xml.indexOf('新しい &amp; &lt;上&gt;')
    const olderAt = xml.indexOf('古い')
    expect(newerAt).toBeGreaterThan(0)
    expect(olderAt).toBeGreaterThan(newerAt)
    expect(xml).toContain(`rel="${OPDS_ACQUISITION_REL}"`)
    expect(xml).toContain(`href="https://opds.example.com/opds/download/${newer}.epub"`)
    expect(xml).toContain('<name>石井</name>')
    expect(xml).toContain('<published>2026-03-01T00:00:00.000Z</published>')
    expect(xml).not.toContain('新しい & <上>')
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
  it('serves the catalog and acquisition download newest-first', async () => {
    const store = createMemoryStore()
    const older = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const newer = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    await store.put(article({ id: older, title: '古い記事' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.put(
      article({
        id: newer,
        title: '新しい記事',
        epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
      }),
    )
    const app = createApp({
      clipPipeline: createClipPipeline({
        extractPipeline: createExtractPipeline({
          fetchPage: async (requested) => ok({ requestedUrl: requested, finalUrl: requested, contentType: 'text/html', html: '' }),
        }),
      }),
      store,
    })
    const catalog = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(catalog.status).toBe(200)
    expect(catalog.headers.get('content-type')).toContain('application/atom+xml')
    const xml = await catalog.text()
    expect(xml.indexOf('新しい記事')).toBeLessThan(xml.indexOf('古い記事'))
    expect(xml).toContain(`https://read.example.com/opds/download/${newer}.epub`)

    const trailing = await app.request(
      'https://read.example.com/opds/',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(trailing.status).toBe(200)
    expect(await trailing.text()).toContain(`https://read.example.com/opds/download/${newer}.epub`)

    const download = await app.request(
      `https://read.example.com/opds/download/${newer}.epub`,
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/epub+zip')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))

    const missing = await app.request(
      'https://read.example.com/opds/download/art_cccccccccccccccccccccccccccccccc.epub',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(missing.status).toBe(404)
  })

  it('serves an empty catalog, rejects unauthorized downloads, and 404s unknown paths', async () => {
    const store = createMemoryStore()
    const app = createApp({
      clipPipeline: createClipPipeline({
        extractPipeline: createExtractPipeline({
          fetchPage: async (requested) =>
            ok({ requestedUrl: requested, finalUrl: requested, contentType: 'text/html', html: '' }),
        }),
      }),
      store,
    })

    const empty = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(empty.status).toBe(200)
    const emptyXml = await empty.text()
    expect(emptyXml).toContain('<title>Xteink Read Later</title>')
    expect(emptyXml).not.toContain('<entry>')

    const noAuthDownload = await app.request(
      'https://read.example.com/opds/download/art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.epub',
      {},
      BINDINGS,
    )
    expect(noAuthDownload.status).toBe(401)

    const unknownPath = await app.request(
      'https://read.example.com/opds/catalog',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(unknownPath.status).toBe(404)

    const badFile = await app.request(
      'https://read.example.com/opds/download/not-an-id.epub',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(badFile.status).toBe(404)
  })
})
