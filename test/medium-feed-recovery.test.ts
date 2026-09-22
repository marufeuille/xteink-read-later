import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractArticle } from '../src/extract/extract-article'
import {
  MEDIUM_FEED_INCOMPLETE,
  createMediumFeedRecovery,
  mediumArticleRef,
  type FetchTextDocument,
} from '../src/extract/sites/medium'
import { looksLikeBotWall, withSiteRecoveries } from '../src/extract/sites/recovery'
import type { FetchPage, HttpUrl } from '../src/types'
import { err, ok, parseHttpUrl } from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))
const authorFeed = readFileSync(join(fixtures, 'fixtures', 'medium-author-feed.xml'), 'utf8')
const articleUrl = mustUrl(
  'https://medium.com/@Ada/agentic-stack-98fbaee9ad10',
)

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(`url: ${value}`)
  }
  return url
}

function page(html: string): Awaited<ReturnType<FetchPage>> {
  return ok({
    requestedUrl: articleUrl,
    finalUrl: articleUrl,
    contentType: 'text/html',
    html,
  })
}

const botWall = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>
<body><h1>Sorry, you have been blocked</h1><p>Cloudflare</p></body></html>`

describe('medium article URLs', () => {
  it('maps author, subdomain, and publication URLs onto their feeds', () => {
    expect(
      mediumArticleRef(
        mustUrl(
          'https://medium.com/@Joannahe/beyond-the-semantic-layer-engineering-the-agentic-data-stack-98fbaee9ad10',
        ),
      ),
    ).toEqual({
      feedUrl: 'https://medium.com/feed/@Joannahe',
      postId: '98fbaee9ad10',
    })
    expect(
      mediumArticleRef(
        mustUrl('https://www.medium.com/@Joannahe/slug-98fbaee9ad10?source=rss'),
      )?.feedUrl,
    ).toBe('https://medium.com/feed/@Joannahe')
    expect(mediumArticleRef(mustUrl('https://joannahe.medium.com/slug-98fbaee9ad10'))).toEqual({
      feedUrl: 'https://medium.com/feed/@joannahe',
      postId: '98fbaee9ad10',
    })
    expect(
      mediumArticleRef(mustUrl('https://medium.com/towards-data-science/slug-98fbaee9ad10'))?.feedUrl,
    ).toBe('https://medium.com/feed/towards-data-science')
  })

  it('ignores profiles, feeds, tags, short links, and other hosts', () => {
    const skipped = [
      'https://medium.com/@Joannahe',
      'https://medium.com/feed/@Joannahe',
      'https://medium.com/tag/semantic-layer-98fbaee9ad10',
      'https://medium.com/p/98fbaee9ad10',
      'https://example.com/posts/slug-98fbaee9ad10',
    ]
    for (const url of skipped) {
      expect(mediumArticleRef(mustUrl(url))).toBeNull()
    }
  })
})

describe('medium feed recovery', () => {
  it('turns a full feed item into an article page', async () => {
    const fetchText: FetchTextDocument = async (url) => {
      expect(url).toBe('https://medium.com/feed/@Ada')
      return ok({ text: authorFeed })
    }
    const fetchPage = withSiteRecoveries(
      async () => err({ kind: 'fetch_failed', url: articleUrl, reason: 'HTTP 403' }),
      [createMediumFeedRecovery(fetchText)],
    )

    const result = await fetchPage(articleUrl)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const extracted = await extractArticle(result.value)
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) {
      return
    }
    expect(extracted.value.title).toBe('エージェントデータスタック')
    expect(extracted.value.author).toBe('Ada')
    expect(extracted.value.publishedAt).toBe('2026-09-16T00:00:00.000Z')
    expect(extracted.value.canonicalUrl).toBe(articleUrl)
    expect(extracted.value.contentHtml).toContain('指標の定義はベンダー')
    expect(extracted.value.contentHtml).toContain('柱 1: Git で管理する定義')
    expect(extracted.value.contentHtml).toContain('metric: revenue')
  })

  it('recovers a Cloudflare interstitial that arrived as HTTP 200', async () => {
    expect(looksLikeBotWall(botWall)).toBe(true)
    expect(looksLikeBotWall('<html><body><p>Cloudflare blocks some clients.</p></body></html>')).toBe(false)
    const fetched: string[] = []
    const fetchText: FetchTextDocument = async (url) => {
      fetched.push(url)
      return ok({ text: authorFeed })
    }
    const fetchPage = withSiteRecoveries(async () => page(botWall), [
      createMediumFeedRecovery(fetchText),
    ])
    const result = await fetchPage(articleUrl)
    expect(result.ok).toBe(true)
    expect(fetched).toEqual(['https://medium.com/feed/@Ada'])
  })

  it('does not fetch a feed when the article HTML is usable', async () => {
    let fetched = false
    const fetchText: FetchTextDocument = async () => {
      fetched = true
      return ok({ text: authorFeed })
    }
    const html = `<!DOCTYPE html><html><head><title>実記事</title></head><body><article><p>${'本文'.repeat(80)}</p></article></body></html>`
    const fetchPage = withSiteRecoveries(async () => page(html), [createMediumFeedRecovery(fetchText)])
    const result = await fetchPage(articleUrl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.html).toBe(html)
    }
    expect(fetched).toBe(false)
  })

  it('marks a truncated or missing feed item as a terminal failure', async () => {
    const truncated = authorFeed.replace(
      '指標の定義はベンダーの中に置かず、リポジトリの宣言ファイルとして扱う。',
      'Read the full story on Medium.',
    )
    const cases = [truncated, authorFeed.replaceAll('98fbaee9ad10', 'bbbbbbbbbbbb')]
    for (const xml of cases) {
      const fetchPage = withSiteRecoveries(
        async () => err({ kind: 'fetch_failed', url: articleUrl, reason: 'HTTP 403' }),
        [createMediumFeedRecovery(async () => ok({ text: xml }))],
      )
      const result = await fetchPage(articleUrl)
      expect(result.ok).toBe(false)
      if (!result.ok && result.error.kind === 'fetch_failed') {
        expect(result.error.terminal).toBe(true)
        expect(result.error.reason).toBe(MEDIUM_FEED_INCOMPLETE)
      }
    }
  })

  it('keeps the original fetch error when the feed itself cannot be fetched', async () => {
    const fetchPage = withSiteRecoveries(
      async () => err({ kind: 'fetch_failed', url: articleUrl, reason: 'HTTP 403' }),
      [
        createMediumFeedRecovery(async (url) =>
          err({ kind: 'fetch_failed', url, reason: 'HTTP 503' }),
        ),
      ],
    )
    const result = await fetchPage(articleUrl)
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'fetch_failed') {
      expect(result.error.reason).toBe('HTTP 403')
      expect(result.error.terminal).toBeUndefined()
    }
  })

  it('leaves non-Medium failures alone', async () => {
    const other = mustUrl('https://example.com/posts/slug-98fbaee9ad10')
    let fetched = false
    const fetchPage = withSiteRecoveries(
      async () => err({ kind: 'fetch_failed', url: other, reason: 'HTTP 403' }),
      [
        createMediumFeedRecovery(async () => {
          fetched = true
          return ok({ text: authorFeed })
        }),
      ],
    )
    const result = await fetchPage(other)
    expect(fetched).toBe(false)
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'fetch_failed') {
      expect(result.error.reason).toBe('HTTP 403')
      expect(result.error.terminal).toBeUndefined()
    }
  })
})
