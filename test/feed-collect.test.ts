import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCandidate } from '../src/candidates/register'
import { FETCH_TIMEOUT_MS } from '../src/extract/constants'
import { collectFeed } from '../src/feeds/collect'
import { RECOMMEND_MAX_CALLS_PER_FEED_ITEM, RECOMMEND_MIN_CONFIDENCE } from '../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import {
  COLLECT_TIME_BUDGET_MS,
  MAX_FEED_BYTES,
  MAX_FEED_ITEMS,
  asFeedRunId,
  asFeedSourceId,
  candidateFeedSourceKind,
  err,
  ok,
  parseHttpUrl,
  type EvaluateSystemOne,
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

describe('collectFeed recommend logs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function recommendLogs(): Record<string, unknown>[] {
    return vi
      .mocked(console.log)
      .mock.calls.map((call) => call[0] as Record<string, unknown>)
      .filter((entry) => entry.event === 'candidate_recommend')
  }

  it('does not emit unevaluated candidate_recommend lines when the feed budget skips Jev', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const candidates = createMemoryCandidateStore()
    const result = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn Cloudflare',
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
    expect(result.status).toBe('ready')
    expect(result.itemsRegistered).toBe(2)
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.map((item) => item.recommendation.status)).toEqual(['unevaluated', 'unevaluated'])
    expect(recommendLogs()).toEqual([])
  })

  it('still logs insufficient material and stays quiet for budget-skipped excerpts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const candidates = createMemoryCandidateStore()
    const pages = {
      ...articlePages,
      'https://zenn.dev/example/articles/durable-intro': readFileSync(
        join(fixtures, 'fixtures', 'too-short.html'),
        'utf8',
      ),
    }
    const result = await collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn Cloudflare',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
      RUN,
      {
        candidateStore: candidates,
        fetchFeed: fetchXml({ 'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml') }),
        fetchPage: fetchHtml(pages),
      },
    )
    expect(result.itemsRegistered).toBe(2)
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.map((item) => item.recommendation.status).sort()).toEqual([
      'insufficient_material',
      'unevaluated',
    ])
    expect(recommendLogs().map((entry) => entry.status)).toEqual(['insufficient_material'])
    expect(JSON.stringify(recommendLogs())).not.toContain('https://')
  })
})

describe('collectFeed de-recommend', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function recommendLogs(): Record<string, unknown>[] {
    return vi
      .mocked(console.log)
      .mock.calls.map((call) => call[0] as Record<string, unknown>)
      .filter((entry) => entry.event === 'candidate_recommend')
  }

  function successfulEvaluate(grade = 'recommended', confidence = 0.92): EvaluateSystemOne {
    return async (request) => {
      expect(request.questions.recommendation?.type).toBe('choice')
      expect(request.questions.de_relevant?.type).toBe('noul')
      const state = request.state as { excerpt?: string }
      expect(state.excerpt?.length ?? 0).toBeGreaterThan(0)
      return {
        ok: true,
        value: {
          model: 'jev-1.13.0',
          answers: {
            recommendation: {
              type: 'choice',
              choice: grade,
              confidence,
              probabilities: { [grade]: confidence },
            },
            de_relevant: { type: 'noul', noul: 0.91 },
            has_concreteness: { type: 'noul', noul: 0.82 },
            has_verification: { type: 'noul', noul: 0.2 },
          },
          usage: { inputTokens: 410, outputTokens: 20 },
        },
      }
    }
  }

  function zenn(input: {
    readonly candidates: ReturnType<typeof createMemoryCandidateStore>
    readonly pages?: Record<string, string>
    readonly fetchPage?: FetchPage
    readonly apiKey?: string
    readonly evaluate?: EvaluateSystemOne
    readonly deadlineMs?: number
  }) {
    return collectFeed(
      source({
        id: ZENN_ID,
        name: 'Zenn Cloudflare',
        siteUrl: mustUrl('https://zenn.dev/topics/cloudflare'),
        feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      }),
      RUN,
      {
        candidateStore: input.candidates,
        fetchFeed: fetchXml({ 'https://zenn.dev/topics/cloudflare/feed': xml('zenn-topic-feed.xml') }),
        fetchPage: input.fetchPage ?? fetchHtml(input.pages ?? articlePages),
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        ...(input.apiKey === undefined ? {} : { jevDeps: { OPENROUTER_API_KEY: input.apiKey } }),
        ...(input.evaluate === undefined ? {} : { evaluateRecommend: input.evaluate }),
      },
    )
  }

  async function listedStatuses(candidates: ReturnType<typeof createMemoryCandidateStore>): Promise<string[]> {
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    return listed.items.map((item) => item.recommendation.status).sort()
  }

  it('keeps the page-fetch budget, the item cap, and the confidence gate', () => {
    expect(RECOMMEND_MAX_CALLS_PER_FEED_ITEM).toBe(0)
    expect(COLLECT_TIME_BUDGET_MS).toBe(20_000)
    expect(FETCH_TIMEOUT_MS).toBe(20_000)
    expect(MAX_FEED_ITEMS).toBe(20)
    expect(MAX_FEED_BYTES).toBe(3_000_000)
    expect(RECOMMEND_MIN_CONFIDENCE).toBe(0.7)
  })

  it('does not call Jev when the key is missing and does not leave body text unevaluated', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async () => {
      calls += 1
      throw new Error('evaluate should not run')
    }
    const candidates = createMemoryCandidateStore()
    const result = await zenn({ candidates, apiKey: '', evaluate })
    expect(result.status).toBe('ready')
    expect(result.itemsRegistered).toBe(2)
    expect(calls).toBe(0)
    expect(await listedStatuses(candidates)).toEqual(['skipped', 'skipped'])
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.every((item) => item.listingState === 'listed')).toBe(true)
    expect(listed.items.every((item) => item.fullTextState === 'confirmed_free')).toBe(true)
    expect(recommendLogs().map((entry) => entry.status).sort()).toEqual(['skipped', 'skipped'])

    const again = await zenn({ candidates, apiKey: '', evaluate })
    expect(again.itemsDuplicate).toBe(2)
    expect(again.itemsRegistered).toBe(0)
    expect(calls).toBe(0)
    expect(await listedStatuses(candidates)).toEqual(['skipped', 'skipped'])
  })

  it('marks short extracts as insufficient material without calling Jev', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async () => {
      calls += 1
      throw new Error('evaluate should not run')
    }
    const pages = {
      'https://zenn.dev/example/articles/feed-collect': readFileSync(
        join(fixtures, 'fixtures', 'too-short.html'),
        'utf8',
      ),
      'https://zenn.dev/example/articles/durable-intro': readFileSync(
        join(fixtures, 'fixtures', 'too-short.html'),
        'utf8',
      ),
    }
    const candidates = createMemoryCandidateStore()
    const result = await zenn({ candidates, pages, apiKey: 'or-test', evaluate })
    expect(result.itemsRegistered).toBe(2)
    expect(calls).toBe(0)
    expect(await listedStatuses(candidates)).toEqual(['insufficient_material', 'insufficient_material'])
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.every((item) => item.listingState === 'listed' && item.recommendation.grade === null)).toBe(
      true,
    )
  })

  it('evaluates extracted feed text with one call and keeps the candidate listed', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, jevDeps) => {
      calls += 1
      return successfulEvaluate()(request, jevDeps)
    }
    const candidates = createMemoryCandidateStore()
    const result = await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(result.itemsRegistered).toBe(2)
    expect(result.itemsSkipped).toBe(0)
    expect(calls).toBe(2)
    expect(await listedStatuses(candidates)).toEqual(['evaluated', 'evaluated'])
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.every((item) => item.listingState === 'listed')).toBe(true)
    expect(listed.items.every((item) => item.recommendation.grade === 'recommended')).toBe(true)
    expect(listed.items.every((item) => item.fullTextState === 'confirmed_free')).toBe(true)
    expect(JSON.stringify(recommendLogs())).not.toContain('https://')
    expect(JSON.stringify(recommendLogs())).not.toContain('or-test')
  })

  it('keeps a failed judgment listed and retries it on a later collection', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async () => {
      calls += 1
      return { ok: false, error: { kind: 'jev_failed', code: 'http', reason: '503' } }
    }
    const candidates = createMemoryCandidateStore()
    const first = await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(first.itemsRegistered).toBe(2)
    expect(calls).toBe(2)
    expect(await listedStatuses(candidates)).toEqual(['failed', 'failed'])
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.every((item) => item.listingState === 'listed' && item.recommendation.grade === null)).toBe(
      true,
    )
    expect(listed.items.every((item) => item.fullTextState === 'confirmed_free')).toBe(true)
    expect(listed.items.every((item) => item.recommendation.errorCode === 'recommend_http')).toBe(true)

    const second = await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(second.itemsRegistered).toBe(0)
    expect(second.itemsDuplicate).toBe(2)
    expect(calls).toBe(4)
    expect(await listedStatuses(candidates)).toEqual(['failed', 'failed'])
    expect(JSON.stringify(recommendLogs())).not.toContain('https://')
  })

  it('does not call Jev again when a later collection sees the same excerpt', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, jevDeps) => {
      calls += 1
      return successfulEvaluate()(request, jevDeps)
    }
    const candidates = createMemoryCandidateStore()
    await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(calls).toBe(2)
    const second = await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(second.itemsDuplicate).toBe(2)
    expect(calls).toBe(2)
    expect(await listedStatuses(candidates)).toEqual(['evaluated', 'evaluated'])
    expect(recommendLogs().filter((entry) => entry.reused === true).length).toBe(2)
  })

  it('does not let Jev wait shrink the page-fetch budget', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const events: string[] = []
    const base = fetchHtml(articlePages)
    const fetchPage: FetchPage = async (url) => {
      events.push('fetch')
      now += 40
      return base(url)
    }
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, jevDeps) => {
      events.push('jev')
      calls += 1
      now += 5_000
      return successfulEvaluate()(request, jevDeps)
    }
    const candidates = createMemoryCandidateStore()
    const result = await zenn({
      candidates,
      fetchPage,
      apiKey: 'or-test',
      evaluate,
      deadlineMs: 1_100,
    })
    expect(result.itemsRegistered).toBe(2)
    expect(result.itemsSkipped).toBe(0)
    expect(calls).toBe(2)
    expect(events).toEqual(['fetch', 'fetch', 'jev', 'jev'])
    expect(await listedStatuses(candidates)).toEqual(['evaluated', 'evaluated'])
  })

  it('judges an unevaluated feed item when a later collection processes it again', async () => {
    const candidates = createMemoryCandidateStore()
    const first = await zenn({ candidates })
    expect(first.itemsRegistered).toBe(2)
    expect(await listedStatuses(candidates)).toEqual(['unevaluated', 'unevaluated'])
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, jevDeps) => {
      calls += 1
      return successfulEvaluate()(request, jevDeps)
    }
    const second = await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(second.itemsRegistered).toBe(0)
    expect(second.itemsDuplicate).toBe(2)
    expect(calls).toBe(2)
    expect(await listedStatuses(candidates)).toEqual(['evaluated', 'evaluated'])
  })

  it('does not judge candidates that this collection did not process', async () => {
    const candidates = createMemoryCandidateStore()
    const outside = 'https://example.com/outside-the-feed'
    const seeded = await registerCandidate(mustUrl(outside), {
      store: candidates,
      fetchPage: fetchHtml({ [outside]: articleHtml(outside, '収集対象外') }),
    })
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) {
      return
    }
    expect(seeded.value.candidate.recommendation.status).toBe('unevaluated')
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, jevDeps) => {
      calls += 1
      return successfulEvaluate()(request, jevDeps)
    }
    await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(calls).toBe(2)
    const untouched = await candidates.getByCanonicalUrl(mustUrl(outside))
    expect(untouched?.recommendation.status).toBe('unevaluated')
    expect(await listedStatuses(candidates)).toEqual(['evaluated', 'evaluated', 'unevaluated'])
  })

  it('does not call Jev for a paywalled feed item and still judges the free one', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, jevDeps) => {
      calls += 1
      return successfulEvaluate()(request, jevDeps)
    }
    const pages = {
      ...articlePages,
      'https://zenn.dev/example/articles/durable-intro': readFileSync(
        join(fixtures, 'fixtures', 'candidate-paywall.html'),
        'utf8',
      ),
    }
    const candidates = createMemoryCandidateStore()
    const result = await zenn({ candidates, pages, apiKey: 'or-test', evaluate })
    expect(result.itemsRegistered).toBe(2)
    expect(calls).toBe(1)
    expect(await listedStatuses(candidates)).toEqual(['evaluated'])
    const paywalled = await candidates.getByCanonicalUrl(
      mustUrl('https://zenn.dev/example/articles/durable-intro'),
    )
    expect(paywalled?.listingState).toBe('excluded')
    expect(paywalled?.recommendation.status).toBe('unevaluated')
    expect(paywalled?.recommendation.grade).toBeNull()
  })

  it('keeps a low-confidence judgment listed and does not call again', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, jevDeps) => {
      calls += 1
      return successfulEvaluate('related', 0.2)(request, jevDeps)
    }
    const candidates = createMemoryCandidateStore()
    await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(calls).toBe(2)
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.every((item) => item.listingState === 'listed')).toBe(true)
    expect(listed.items.map((item) => item.recommendation.status).sort()).toEqual([
      'low_confidence',
      'low_confidence',
    ])
    expect(listed.items.every((item) => item.recommendation.grade === null)).toBe(true)
    await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(calls).toBe(2)
  })

  it('records a thrown judgment as failed without failing the collection', async () => {
    let calls = 0
    const evaluate: EvaluateSystemOne = async () => {
      calls += 1
      throw new Error('jev exploded')
    }
    const candidates = createMemoryCandidateStore()
    const result = await zenn({ candidates, apiKey: 'or-test', evaluate })
    expect(result.status).toBe('ready')
    expect(result.itemsRegistered).toBe(2)
    expect(calls).toBe(2)
    expect(await listedStatuses(candidates)).toEqual(['failed', 'failed'])
    const listed = await candidates.listListed({ limit: 10, offset: 0 })
    expect(listed.items.every((item) => item.recommendation.errorCode === 'recommend_internal')).toBe(true)
    expect(JSON.stringify(recommendLogs())).not.toContain('jev exploded')
    expect(JSON.stringify(recommendLogs())).not.toContain('https://')
  })
})
