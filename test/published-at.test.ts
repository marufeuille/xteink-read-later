import { describe, expect, it } from 'vitest'
import { extractCandidateMetadata } from '../src/candidates/metadata'
import { extractArticle } from '../src/extract/extract-article'
import {
  DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS,
  developersIoDatePublished,
  isDevelopersIoCandidateUrl,
} from '../src/extract/published-at'
import { parseHttpUrl, type FetchedPage, type HttpUrl } from '../src/types'
import {
  DEVELOPERS_IO_ARTICLE_URL,
  DEVELOPERS_IO_EVENT_DATETIME,
  DEVELOPERS_IO_PUBLISHED_AT,
  developersIoArticleHtml,
} from './developersio-fixture'

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function page(url: string, html: string, finalUrl = url): FetchedPage {
  return {
    requestedUrl: mustUrl(url),
    finalUrl: mustUrl(finalUrl),
    contentType: 'text/html',
    html,
  }
}

const EVENT_ISO = '2026-10-27T06:00:00.000Z'

describe('DevelopersIO published dates', () => {
  it('uses the article date embedded in Next.js data instead of the first sidebar time', async () => {
    const html = developersIoArticleHtml()
    const fetched = page(DEVELOPERS_IO_ARTICLE_URL, html)
    expect(developersIoDatePublished(html)).toBe(DEVELOPERS_IO_PUBLISHED_AT)
    expect(extractCandidateMetadata(fetched).publishedAt).toBe(DEVELOPERS_IO_PUBLISHED_AT)
    const extracted = await extractArticle(fetched)
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) {
      return
    }
    expect(extracted.value.publishedAt).toBe(DEVELOPERS_IO_PUBLISHED_AT)
    expect(extracted.value.publishedAt).not.toBe(EVENT_ISO)
  })

  it('leaves the published date unknown when the article date is missing, even if event times exist', async () => {
    const html = developersIoArticleHtml({ articleDate: null })
    const fetched = page(DEVELOPERS_IO_ARTICLE_URL, html)
    expect(extractCandidateMetadata(fetched).publishedAt).toBeNull()
    const extracted = await extractArticle(fetched)
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) {
      return
    }
    expect(extracted.value.publishedAt).toBeNull()
    expect(html).toContain(DEVELOPERS_IO_EVENT_DATETIME)
  })

  it('keeps JSON-LD datePublished and article:published_time ahead of the embed and sidebar time', () => {
    const jsonLd = developersIoArticleHtml({ jsonLdPublished: '2026-07-01T00:00:00Z' })
    expect(extractCandidateMetadata(page(DEVELOPERS_IO_ARTICLE_URL, jsonLd)).publishedAt).toBe(
      '2026-07-01T00:00:00.000Z',
    )
    const meta = developersIoArticleHtml({ metaPublished: '2026-08-01T00:00:00Z' })
    expect(extractCandidateMetadata(page(DEVELOPERS_IO_ARTICLE_URL, meta)).publishedAt).toBe(
      '2026-08-01T00:00:00.000Z',
    )
  })

  it('still reads datePublished, article:published_time, and a lone time element on other hosts', () => {
    const dated = `<!DOCTYPE html><html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Real date","datePublished":"2026-03-01T00:00:00Z"}</script>
      <title>Real date</title>
      <meta property="og:title" content="Real date" />
    </head><body><time datetime="2026-12-01T00:00:00Z">event</time><article><h1>Real date</h1><p>${'本文'.repeat(80)}</p></article></body></html>`
    expect(extractCandidateMetadata(page('https://example.com/dated', dated)).publishedAt).toBe(
      '2026-03-01T00:00:00.000Z',
    )

    const meta = `<!DOCTYPE html><html><head>
      <meta property="article:published_time" content="2026-04-05T01:02:03Z" />
      <title>Meta date</title>
      <meta property="og:title" content="Meta date" />
    </head><body><time datetime="2026-12-01T00:00:00Z">event</time><article><h1>Meta date</h1><p>${'本文'.repeat(80)}</p></article></body></html>`
    expect(extractCandidateMetadata(page('https://notes.example/meta', meta)).publishedAt).toBe(
      '2026-04-05T01:02:03.000Z',
    )

    const timeOnly = `<!DOCTYPE html><html><head>
      <title>Time only post</title>
      <meta property="og:title" content="Time only post" />
      <link rel="canonical" href="https://example.com/time-only" />
    </head><body><article><h1>Time only post</h1>
      <time datetime="2026-01-02T03:04:05Z">Jan 2</time>
      <p>${'公開日が time 要素だけのサイトではその datetime を使う。'.repeat(4)}</p>
    </article></body></html>`
    expect(extractCandidateMetadata(page('https://example.com/time-only', timeOnly)).publishedAt).toBe(
      '2026-01-02T03:04:05.000Z',
    )

    const mirrored = developersIoArticleHtml()
    expect(extractCandidateMetadata(page('https://example.com/mirror', mirrored)).publishedAt).toBe(EVENT_ISO)
  })

  it('treats a DevelopersIO request URL as DevelopersIO even if the final URL left the host', () => {
    const html = developersIoArticleHtml()
    const fetched = page(DEVELOPERS_IO_ARTICLE_URL, html, 'https://example.com/consent')
    expect(extractCandidateMetadata(fetched).publishedAt).toBe(DEVELOPERS_IO_PUBLISHED_AT)
  })

  it('matches only the DevelopersIO host for stored candidate URLs', () => {
    expect(DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS).toEqual([
      'https://dev.classmethod.jp/%',
      'http://dev.classmethod.jp/%',
    ])
    const samples = [
      DEVELOPERS_IO_ARTICLE_URL,
      'http://dev.classmethod.jp/articles/example/',
      'https://dev.classmethod.jp/',
      'https://dev.classmethod.jp.evil.test/articles/x/',
      'https://example.com/dev.classmethod.jp/articles/x/',
      'https://www.classmethod.jp/articles/x/',
    ]
    const developersIo = samples.filter((url) => isDevelopersIoCandidateUrl(url))
    expect(developersIo).toEqual([
      DEVELOPERS_IO_ARTICLE_URL,
      'http://dev.classmethod.jp/articles/example/',
      'https://dev.classmethod.jp/',
    ])
    const stored = developersIo.map((url) => mustUrl(url))
    expect(stored.every((url) => DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS.some((pattern) => url.startsWith(pattern.slice(0, -1))))).toBe(
      true,
    )
    expect(
      samples
        .filter((url) => !isDevelopersIoCandidateUrl(url))
        .some((url) => DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS.some((pattern) => url.startsWith(pattern.slice(0, -1)))),
    ).toBe(false)
  })
})
