import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryFeedSourceStore } from '../src/store/memory-sources'
import { createMemoryStore } from '../src/store/memory'
import {
  asFeedSourceId,
  err,
  ok,
  type FetchFeed,
  type FetchPage,
} from '../src/types'
import { accessIdentity, bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'
import { createFakeFeedQueue } from './fake-feed-queue'
import { createFakeQueue } from './fake-queue'

const fixtures = dirname(fileURLToPath(import.meta.url))

function xml(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function articleHtml(url: string, title: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><title>${title}</title><link rel="canonical" href="${url}" /></head>
<body><article><h1>${title}</h1><p>${title} の本文です。候補登録の抽出が通るだけの長さを持たせます。Cloudflare Workers。</p>
<p>二段落目も入れて最小文字数を超えます。</p></article></body></html>`
}

function fetchXml(pages: Record<string, string | { xml: string; error?: 'failed' | 'too_large' }>): FetchFeed {
  return async (url) => {
    const page = pages[url]
    if (page === undefined) {
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    }
    if (typeof page !== 'string') {
      if (page.error === 'too_large') {
        return err({ kind: 'payload_too_large', bytes: 2_000_000 })
      }
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 500' })
    }
    return ok({
      requestedUrl: url,
      finalUrl: url,
      contentType: 'application/rss+xml',
      xml: page,
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

function appWith(
  options: { fetchPage?: FetchPage; fetchFeed?: FetchFeed; access?: boolean } = {},
) {
  const candidateStore = createMemoryCandidateStore()
  const sourceStore = createMemoryFeedSourceStore()
  const queue = createFakeQueue()
  const feedQueue = createFakeFeedQueue()
  const fetchPage =
    options.fetchPage ??
    fetchHtml({
      ...articlePages,
      'https://blog.example.com/': html('site-with-feed.html'),
      'https://silent.example.com/': html('site-without-feed.html'),
    })
  const fetchFeed =
    options.fetchFeed ??
    fetchXml({
      'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml'),
      'https://engineering.mercari.com/blog/feed.xml': xml('mercari-engineering-feed.xml'),
      'https://blog.example.com/blog/feed.xml': xml('zenn-topic-feed.xml'),
      'https://example.com/not-feed': xml('invalid-feed.xml'),
    })
  const app = createApp({
    store: createMemoryStore(),
    queue,
    feedQueue,
    candidateStore,
    sourceStore,
    fetchPage,
    fetchFeed,
    ...(options.access === true ? accessIdentity() : {}),
  })
  const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue, FEED_QUEUE: feedQueue } as Cloudflare.Env
  return { app, candidateStore, sourceStore, queue, feedQueue, env }
}

const jsonHeaders = {
  'content-type': 'application/json',
  authorization: bearerAuthorization(),
}

describe('source HTTP', () => {
  it('rejects unauthenticated source list and writes', async () => {
    const { app, env } = appWith()
    const listed = await app.request('/sources.json', { headers: { accept: 'application/json' } }, env)
    expect(listed.status).toBe(401)
    const created = await app.request(
      '/sources',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          name: 'Zenn',
          siteUrl: 'https://zenn.dev/topics/cloudflare',
          feedUrl: 'https://zenn.dev/topics/cloudflare/feed',
          sourceType: 'posting_site',
        }),
      },
      env,
    )
    expect(created.status).toBe(401)
    expect(await created.text()).not.toContain(TEST_CLIP_TOKEN)
    const htmlGet = await app.request('/sources', {}, env)
    expect(htmlGet.status).toBe(401)
    expect(await htmlGet.text()).toContain('Google アカウントで入る')
  })

  it('accepts Access HTML and rejects form collect without CSRF', async () => {
    const { app, env } = appWith({ access: true })
    const listed = await app.request('/sources', {}, env)
    expect(listed.status).toBe(200)
    const page = await listed.text()
    expect(page).toContain('情報源')
    expect(page).not.toContain(TEST_CLIP_TOKEN)
    const denied = await app.request(
      '/sources/collect',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: 'nope' }).toString(),
      },
      env,
    )
    expect(denied.status).toBe(403)
  })

  it('discovers a feed from the site URL and asks for a feed URL when missing', async () => {
    const { app, env } = appWith()
    const created = await app.request(
      '/sources',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: 'Example corp',
          siteUrl: 'https://blog.example.com/',
          sourceType: 'corporate_blog',
          topicTags: ['workers'],
        }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const body = (await created.json()) as { source: { feedUrl: string; topicTags: string[] } }
    expect(body.source.feedUrl).toBe('https://blog.example.com/blog/feed.xml')
    expect(body.source.topicTags).toEqual(['workers'])

    const missing = await app.request(
      '/sources',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: 'Silent',
          siteUrl: 'https://silent.example.com/',
          sourceType: 'news',
        }),
      },
      env,
    )
    expect(missing.status).toBe(400)
    const missingBody = (await missing.json()) as { error: { code: string; message: string } }
    expect(missingBody.error.code).toBe('invalid_feed')
    expect(missingBody.error.message).toContain('フィード URL')
  })

  it('updates type, tags, and stop/resume without deleting candidates', async () => {
    const ctx = appWith()
    const created = await ctx.app.request(
      '/sources',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: 'Zenn Cloudflare',
          siteUrl: 'https://zenn.dev/topics/cloudflare',
          feedUrl: 'https://zenn.dev/topics/cloudflare/feed',
          sourceType: 'posting_site',
        }),
      },
      ctx.env,
    )
    const createdBody = (await created.json()) as { id: string }
    const collect = await ctx.app.request(
      `/sources/${createdBody.id}/collect`,
      { method: 'POST', headers: jsonHeaders },
      ctx.env,
    )
    expect(collect.status).toBe(202)
    await ctx.feedQueue.drain(ctx.env, {
      sourceStore: ctx.sourceStore,
      candidateStore: ctx.candidateStore,
      fetchFeed: fetchXml({ 'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml') }),
      fetchPage: fetchHtml(articlePages),
    })
    expect((await ctx.candidateStore.listListed({ limit: 10, offset: 0 })).total).toBe(2)
    expect(ctx.queue.size).toBe(0)

    const stopped = await ctx.app.request(
      `/sources/${createdBody.id}`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: 'Zenn Cloudflare',
          siteUrl: 'https://zenn.dev/topics/cloudflare',
          feedUrl: 'https://zenn.dev/topics/cloudflare/feed',
          sourceType: 'curation',
          topicTags: 'cloudflare, rss',
          enabled: false,
        }),
      },
      ctx.env,
    )
    expect(stopped.status).toBe(200)
    const source = ((await stopped.json()) as { source: { enabled: boolean; sourceType: string; topicTags: string[] } })
      .source
    expect(source.enabled).toBe(false)
    expect(source.sourceType).toBe('curation')
    expect(source.topicTags).toEqual(['cloudflare', 'rss'])

    const blocked = await ctx.app.request(
      `/sources/${createdBody.id}/collect`,
      { method: 'POST', headers: jsonHeaders },
      ctx.env,
    )
    expect(blocked.status).toBe(409)
    expect((await ctx.candidateStore.listListed({ limit: 10, offset: 0 })).total).toBe(2)
  })

  it('retries a failed collection after the feed recovers', async () => {
    const feeds: Record<string, string | { xml: string; error?: 'failed' | 'too_large' }> = {
      'https://zenn.dev/topics/cloudflare/feed': { xml: '', error: 'failed' },
    }
    const ctx = appWith({ fetchFeed: fetchXml(feeds) })
    const created = await ctx.app.request(
      '/sources',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: 'Zenn',
          siteUrl: 'https://zenn.dev/topics/cloudflare',
          feedUrl: 'https://zenn.dev/topics/cloudflare/feed',
          sourceType: 'posting_site',
        }),
      },
      ctx.env,
    )
    const id = ((await created.json()) as { id: string }).id
    await ctx.app.request(`/sources/${id}/collect`, { method: 'POST', headers: jsonHeaders }, ctx.env)
    await ctx.feedQueue.drain(ctx.env, {
      sourceStore: ctx.sourceStore,
      candidateStore: ctx.candidateStore,
      fetchFeed: fetchXml(feeds),
      fetchPage: fetchHtml(articlePages),
    })
    expect((await ctx.sourceStore.getById(asFeedSourceId(id)))?.collectionStatus).toBe('failed')

    feeds['https://zenn.dev/topics/cloudflare/feed'] = xml('zenn-topic-feed.xml')
    await ctx.app.request(`/sources/${id}/collect`, { method: 'POST', headers: jsonHeaders }, ctx.env)
    await ctx.feedQueue.drain(ctx.env, {
      sourceStore: ctx.sourceStore,
      candidateStore: ctx.candidateStore,
      fetchFeed: fetchXml(feeds),
      fetchPage: fetchHtml(articlePages),
    })
    const retried = (await ctx.sourceStore.list())[0]
    expect(retried?.collectionStatus).toBe('ready')
    expect(retried?.itemsRegistered).toBe(2)
  })
})
