import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectFeed } from '../src/feeds/collect'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import {
  asFeedRunId,
  asFeedSourceId,
  candidateFeedSourceKind,
  err,
  ok,
  parseHttpUrl,
  type FeedSource,
  type FetchFeed,
  type FetchPage,
  type HttpUrl,
} from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))

function xml(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function articleHtml(url: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <link rel="canonical" href="${url}" />
</head>
<body>
  <article>
    <h1>${title}</h1>
    <p>${title} の本文です。候補登録の抽出が通るだけの長さを持たせます。Cloudflare Workers のフィード収集。</p>
    <p>二段落目も入れて最小文字数を超えます。テスト用の固定 HTML です。</p>
  </article>
</body>
</html>`
}

const articlePages = {
  'https://zenn.dev/example/articles/feed-collect': articleHtml(
    'https://zenn.dev/example/articles/feed-collect',
    'Workers で RSS を読む',
  ),
  'https://zenn.dev/example/articles/durable-intro': articleHtml(
    'https://zenn.dev/example/articles/durable-intro',
    'Durable Objects 入門',
  ),
  'https://engineering.mercari.com/blog/entry/2026-09-01-hello/': articleHtml(
    'https://engineering.mercari.com/blog/entry/2026-09-01-hello/',
    'Hello from Mercari Engineering',
  ),
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

const RUN = asFeedRunId('frun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const ZENN_ID = asFeedSourceId('src_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const MERCARI_ID = asFeedSourceId('src_cccccccccccccccccccccccccccccccc')

function source(partial: Pick<FeedSource, 'id' | 'feedUrl' | 'siteUrl' | 'name'> & Partial<FeedSource>): FeedSource {
  return {
    sourceType: 'posting_site',
    topicTags: [],
    enabled: true,
    collectionRunId: RUN,
    collectionStatus: 'running',
    collectionAttempt: 1,
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

function fetchXml(pages: Record<string, string>): FetchFeed {
  return async (url) => {
    const body = pages[url]
    if (body === undefined) {
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    }
    return ok({
      requestedUrl: url,
      finalUrl: url,
      contentType: 'application/rss+xml',
      xml: body,
    })
  }
}

function fetchHtml(pages: Record<string, string>): FetchPage {
  return async (url) => {
    const body = pages[url]
    if (body === undefined) {
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    }
    return ok({
      requestedUrl: url,
      finalUrl: url,
      contentType: 'text/html',
      html: body,
    })
  }
}

describe('collectFeed', () => {
  it('registers feed items as candidates and keeps a feed discovery kind', async () => {
    const candidates = createMemoryCandidateStore()
    const result = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn Cloudflare',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
        sourceType: 'posting_site',
      }),
      RUN,
      {
        candidateStore: candidates,
        fetchFeed: fetchXml({ 'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml') }),
        fetchPage: fetchHtml(articlePages),
      },
    )
    expect(result.status).toBe('ready')
    expect(result.itemsRegistered).toBe(2)
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.total).toBe(2)
    const first = listed.items[0]
    expect(first).toBeDefined()
    if (first === undefined) {
      return
    }
    const discoveries = await candidates.listDiscoveries(first.id)
    expect(discoveries.some((row) => row.sourceKind === candidateFeedSourceKind(ZENN_ID))).toBe(true)
  })

  it('dedupes the same article from another feed and keeps both discoveries', async () => {
    const candidates = createMemoryCandidateStore()
    const deps = {
      candidateStore: candidates,
      fetchFeed: fetchXml({
        'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml'),
        'https://engineering.mercari.com/blog/feed.xml': xml('mercari-engineering-feed.xml'),
      }),
      fetchPage: fetchHtml(articlePages),
    }
    await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
      RUN,
      deps,
    )
    const second = await collectFeed(
      source({
        id: MERCARI_ID,
        name: 'Mercari',
        siteUrl: mustUrl('https://engineering.mercari.com/blog/'),
        feedUrl: mustUrl('https://engineering.mercari.com/blog/feed.xml'),
        sourceType: 'corporate_blog',
      }),
      RUN,
      deps,
    )
    expect(second.itemsDuplicate).toBeGreaterThan(0)
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    const shared = listed.items.find((item) => item.canonicalUrl === 'https://zenn.dev/example/articles/feed-collect')
    expect(shared).toBeDefined()
    if (shared === undefined) {
      return
    }
    const discoveries = await candidates.listDiscoveries(shared.id)
    expect(discoveries.map((row) => row.sourceKind).sort()).toEqual(
      [candidateFeedSourceKind(MERCARI_ID), candidateFeedSourceKind(ZENN_ID)].sort(),
    )
  })

  it('does not fetch a stopped source and does not delete existing candidates', async () => {
    const candidates = createMemoryCandidateStore()
    const first = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
      RUN,
      {
        candidateStore: candidates,
        fetchFeed: fetchXml({ 'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml') }),
        fetchPage: fetchHtml(articlePages),
      },
    )
    expect(first.itemsRegistered).toBe(2)
    const stopped = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
        enabled: false,
      }),
      RUN,
      {
        candidateStore: candidates,
        fetchFeed: async () => {
          throw new Error('must not fetch')
        },
        fetchPage: async () => {
          throw new Error('must not fetch')
        },
      },
    )
    expect(stopped.status).toBe('ready')
    expect(stopped.itemsRegistered).toBe(0)
    expect((await candidates.listListed({ limit: 10, offset: 0 })).total).toBe(2)
  })

  it('caps item count and skips the rest', async () => {
    const candidates = createMemoryCandidateStore()
    const result = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
      RUN,
      {
        candidateStore: candidates,
        fetchFeed: fetchXml({ 'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml') }),
        fetchPage: fetchHtml(articlePages),
        maxItems: 1,
      },
    )
    expect(result.itemsSeen).toBe(2)
    expect(result.itemsRegistered).toBe(1)
    expect(result.itemsSkipped).toBe(1)
  })

  it('skips remaining items when the time budget is already exhausted', async () => {
    const result = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
      RUN,
      {
        candidateStore: createMemoryCandidateStore(),
        fetchFeed: fetchXml({ 'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml') }),
        fetchPage: fetchHtml(articlePages),
        deadlineMs: 0,
      },
    )
    expect(result.status).toBe('ready')
    expect(result.itemsRegistered).toBe(0)
    expect(result.itemsSkipped).toBe(2)
  })

  it('records invalid feeds as a failed collection', async () => {
    const result = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Bad',
        siteUrl: mustUrl('https://example.com/'),
        feedUrl: mustUrl('https://example.com/not-feed'),
      }),
      RUN,
      {
        candidateStore: createMemoryCandidateStore(),
        fetchFeed: fetchXml({ 'https://example.com/not-feed': xml('invalid-feed.xml') }),
        fetchPage: fetchHtml({}),
      },
    )
    expect(result.status).toBe('failed')
    expect(result.error?.kind).toBe('invalid_feed')
  })

  it('isolates a failed source from a successful one', async () => {
    const candidates = createMemoryCandidateStore()
    const failed = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Down',
        siteUrl: mustUrl('https://missing.example.com/'),
        feedUrl: mustUrl('https://missing.example.com/feed.xml'),
      }),
      RUN,
      {
        candidateStore: candidates,
        fetchFeed: fetchXml({}),
        fetchPage: fetchHtml({}),
      },
    )
    const okResult = await collectFeed(
      source({
        id: MERCARI_ID,
        name: 'Mercari',
        siteUrl: mustUrl('https://engineering.mercari.com/blog/'),
        feedUrl: mustUrl('https://engineering.mercari.com/blog/feed.xml'),
        sourceType: 'corporate_blog',
      }),
      RUN,
      {
        candidateStore: candidates,
        fetchFeed: fetchXml({
          'https://engineering.mercari.com/blog/feed.xml': xml('mercari-engineering-feed.xml'),
        }),
        fetchPage: fetchHtml(articlePages),
      },
    )
    expect(failed.status).toBe('failed')
    expect(okResult.status).toBe('ready')
    expect(okResult.itemsRegistered).toBeGreaterThan(0)
  })
})
