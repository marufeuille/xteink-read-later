import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { buildDummyDailyWrite } from '../src/daily/issue'
import { publishLatestDaily } from '../src/daily/publish'
import { runDailyDigest } from '../src/daily/run'
import { selectDigestCandidates } from '../src/daily/select'
import { summarizeDigestArticle, type SummarizeDigestArticle } from '../src/daily/summarize'
import { handleScheduled } from '../src/schedule'
import { unavailableClassification } from '../src/classify/taxonomy'
import { evaluatedRecommendation, unevaluatedRecommendation } from '../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryDigestStore } from '../src/store/memory-digest'
import { createMemoryFeedSourceStore } from '../src/store/memory-sources'
import { createMemoryStore } from '../src/store/memory'
import {
  asArticleId,
  asCandidateId,
  asEpubBytes,
  asFeedSourceId,
  DAILY_DIGEST_CRON,
  FEED_COLLECT_CRON,
  ok,
  parseHttpUrl,
  purchasedCanonicalUrl,
  type ArticleStore,
  type ArticleWrite,
  type CandidateArticle,
  type CandidateStore,
  type DigestStore,
  type EvaluateSystemOne,
  type FetchPage,
  type HttpUrl,
  type RecommendGrade,
} from '../src/types'
import { bearerAuthorization, TEST_BINDINGS } from './bindings'
import { createFakeDigestQueue } from './fake-digest-queue'
import { createFakeFeedQueue } from './fake-feed-queue'
import { createFakeQueue } from './fake-queue'

const root = dirname(fileURLToPath(import.meta.url))
const ORIGIN = mustUrl('https://read.example.com')
const TODAY = '2026-09-21'
const YESTERDAY = '2026-09-20'
const NOW = new Date('2026-09-21T03:00:00.000Z')

function mustUrl(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function epubChapter(epub: Uint8Array): string {
  const files = unzipSync(epub)
  return strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
}

function judged(grade: RecommendGrade) {
  return evaluatedRecommendation({
    grade,
    confidence: 0.92,
    model: 'test-model',
    excerptHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    evaluatedAt: NOW.toISOString(),
    relevant: grade !== 'low_priority',
    concrete: grade === 'recommended',
    verification: grade === 'recommended',
    inputTokens: 12,
    durationMs: 8,
  })
}

function listedCandidate(
  overrides: Partial<CandidateArticle> & Pick<CandidateArticle, 'id' | 'canonicalUrl' | 'title'>,
): CandidateArticle {
  const now = NOW.toISOString()
  return {
    sourceUrl: overrides.canonicalUrl,
    outlet: 'example.com',
    publishedAt: '2026-09-21T00:00:00.000Z',
    discoveredAt: now,
    fetchStatus: 'fetched',
    listingState: 'listed',
    exclusionReason: null,
    fullTextState: 'confirmed_free',
    completedArticleId: null,
    clipJobId: null,
    clipRunId: null,
    selectedAt: null,
    recommendation: judged('recommended'),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const TITLE_ONLY_HTML =
  '<!DOCTYPE html><html><head><title>タイトルだけ</title></head><body><p>短い</p></body></html>'

function clipWrite(title: string): ArticleWrite {
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

function purchasedWrite(title: string): ArticleWrite {
  const id = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  const canonicalUrl = purchasedCanonicalUrl(id)
  return {
    id,
    title,
    author: '著者',
    publishedAt: null,
    sourceUrl: canonicalUrl,
    canonicalUrl,
    language: 'ja',
    translated: false,
    classification: unavailableClassification('skipped'),
    epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 4, 5, 6])),
  }
}

const summarizeOk = async (candidate: CandidateArticle) =>
  ok({
    candidateId: candidate.id,
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    summaryHtml: `<p>要約 ${candidate.title}</p>`,
  })

const unusedFetch: FetchPage = async () => {
  throw new Error('fetch should not run')
}

function queues() {
  return {
    clip: createFakeQueue(),
    feed: createFakeFeedQueue(),
    digest: createFakeDigestQueue(),
  }
}

function envWithQueues(input: ReturnType<typeof queues>): Cloudflare.Env {
  return {
    ...TEST_BINDINGS,
    CLIP_QUEUE: input.clip,
    FEED_QUEUE: input.feed,
    DIGEST_QUEUE: input.digest,
  } as Cloudflare.Env
}

function memoryDigest() {
  return {
    candidateStore: createMemoryCandidateStore(),
    digestStore: createMemoryDigestStore(),
    store: createMemoryStore(),
  }
}

async function putYesterday(store: ArticleStore) {
  const yesterday = await buildDummyDailyWrite({ date: YESTERDAY, origin: ORIGIN, bodyMarker: 'DAY-2026-09-20' })
  await publishLatestDaily(store, yesterday.write)
  return yesterday
}

async function sortedTitles(store: ArticleStore): Promise<string[]> {
  return (await store.listMeta()).map((item) => item.title).sort()
}

async function runDigest(input: {
  readonly store: ArticleStore
  readonly candidateStore: CandidateStore
  readonly digestStore: DigestStore
  readonly fetchPage?: FetchPage
  readonly summarize?: SummarizeDigestArticle
  readonly evaluateRecommend?: EvaluateSystemOne
  readonly env?: Cloudflare.Env
}): Promise<Awaited<ReturnType<typeof runDailyDigest>>> {
  return runDailyDigest(input.env ?? ({ ...TEST_BINDINGS } as Cloudflare.Env), {
    date: TODAY,
    store: input.store,
    candidateStore: input.candidateStore,
    digestStore: input.digestStore,
    fetchPage: input.fetchPage ?? unusedFetch,
    summarize: input.summarize ?? summarizeOk,
    now: () => NOW,
    ...(input.evaluateRecommend === undefined ? {} : { evaluateRecommend: input.evaluateRecommend }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('daily digest cron', () => {
  it('adds the digest cron without changing the collection cron', () => {
    const wrangler = readFileSync(join(root, '..', 'wrangler.jsonc'), 'utf8')
    expect(wrangler).toContain(`"${FEED_COLLECT_CRON}"`)
    expect(wrangler).toContain(`"${DAILY_DIGEST_CRON}"`)
    expect(FEED_COLLECT_CRON).toBe('0 19 * * *')
    expect(DAILY_DIGEST_CRON).toBe('0 21 * * *')
  })

  it('enqueues feed collection only for the collection cron', async () => {
    const sourceStore = createMemoryFeedSourceStore()
    await sourceStore.put({
      id: asFeedSourceId('src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      name: 'Zenn',
      siteUrl: mustUrl('https://example.com/'),
      feedUrl: mustUrl('https://zenn.dev/topics/cloudflare/feed'),
      sourceType: 'posting_site',
      topicTags: [],
      enabled: true,
      collectionRunId: null,
      collectionStatus: null,
      collectionAttempt: 0,
      collectionErrorCode: null,
      collectionErrorMessage: null,
      itemsSeen: 0,
      itemsRegistered: 0,
      itemsDuplicate: 0,
      itemsSkipped: 0,
      lastCollectedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    const { clip, feed, digest } = queues()
    const result = await handleScheduled({ cron: FEED_COLLECT_CRON }, envWithQueues({ clip, feed, digest }), {
      sourceStore,
      feedQueue: feed,
      digestQueue: digest,
      now: () => NOW,
    })
    expect(result).toMatchObject({ kind: 'feed_collect', queued: 1, failed: 0 })
    expect(feed.size).toBe(1)
    expect(digest.size).toBe(0)
    expect(clip.size).toBe(0)
  })

  it('enqueues digest work only for the digest cron', async () => {
    const { clip, feed, digest } = queues()
    const result = await handleScheduled({ cron: DAILY_DIGEST_CRON }, envWithQueues({ clip, feed, digest }), {
      feedQueue: feed,
      digestQueue: digest,
      now: () => NOW,
    })
    expect(result).toMatchObject({ kind: 'daily_digest', queued: 1, failed: 0 })
    expect(digest.peek()).toEqual([{ date: TODAY }])
    expect(feed.size).toBe(0)
    expect(clip.size).toBe(0)
  })

  it('ignores unknown cron expressions', async () => {
    const { clip, feed, digest } = queues()
    const result = await handleScheduled({ cron: '0 12 * * *' }, envWithQueues({ clip, feed, digest }), {
      feedQueue: feed,
      digestQueue: digest,
      now: () => NOW,
    })
    expect(result.kind).toBe('unknown')
    expect(feed.size).toBe(0)
    expect(digest.size).toBe(0)
    expect(clip.size).toBe(0)
  })
})

describe('daily digest selection', () => {
  it('drops paywalled, fetch-failed, excluded, and unconfirmed candidates', () => {
    const keep = listedCandidate({
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      canonicalUrl: mustUrl('https://example.com/keep'),
      title: '深い記事',
    })
    const selected = selectDigestCandidates(
      [
        keep,
        listedCandidate({
          id: asCandidateId('cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
          canonicalUrl: mustUrl('https://example.com/paywall'),
          title: '有料',
          listingState: 'excluded',
          exclusionReason: 'paywalled',
          fullTextState: 'unavailable',
        }),
        listedCandidate({
          id: asCandidateId('cand_cccccccccccccccccccccccccccccccc'),
          canonicalUrl: mustUrl('https://example.com/failed'),
          title: '取得失敗',
          fetchStatus: 'fetch_failed',
          fullTextState: 'unconfirmed',
        }),
        listedCandidate({
          id: asCandidateId('cand_dddddddddddddddddddddddddddddddd'),
          canonicalUrl: mustUrl('https://example.com/excerpt-only'),
          title: '抜粋だけ',
          fullTextState: 'unconfirmed',
        }),
      ],
      { usedCanonicalUrls: new Set() },
    )
    expect(selected.map((item) => item.id)).toEqual([keep.id])
  })

  it('does not pad quotas when fewer eligible articles exist', () => {
    const selected = selectDigestCandidates(
      [
        listedCandidate({
          id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
          canonicalUrl: mustUrl('https://example.com/one'),
          title: '深い1',
        }),
        listedCandidate({
          id: asCandidateId('cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
          canonicalUrl: mustUrl('https://example.com/two'),
          title: '深い2',
        }),
      ],
      { usedCanonicalUrls: new Set() },
    )
    expect(selected).toHaveLength(2)
  })

  it('keeps deep, tech, and general counts within the configured maxima', () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) =>
        listedCandidate({
          id: asCandidateId(`cand_a${String(index).padStart(31, '0')}`),
          canonicalUrl: mustUrl(`https://example.com/deep/${index}`),
          title: `深掘り${index}`,
          discoveredAt: `2026-09-21T00:0${index}:00.000Z`,
        }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        listedCandidate({
          id: asCandidateId(`cand_b${String(index).padStart(31, '0')}`),
          canonicalUrl: mustUrl(`https://example.com/tech/${index}`),
          title: `技術${index}`,
          recommendation: judged('related'),
          discoveredAt: `2026-09-21T01:0${index}:00.000Z`,
        }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        listedCandidate({
          id: asCandidateId(`cand_c${String(index).padStart(31, '0')}`),
          canonicalUrl: mustUrl(`https://example.com/general/${index}`),
          title: `一般${index}`,
          recommendation: judged('low_priority'),
          discoveredAt: `2026-09-21T02:0${index}:00.000Z`,
        }),
      ),
    ]
    const selected = selectDigestCandidates(candidates, { usedCanonicalUrls: new Set() })
    const deep = selected.filter((item) => item.recommendation.grade === 'recommended')
    const tech = selected.filter((item) => item.recommendation.grade === 'related')
    const general = selected.filter((item) => item.recommendation.grade === 'low_priority')
    expect(deep).toHaveLength(5)
    expect(tech).toHaveLength(3)
    expect(general).toHaveLength(2)
  })
})

describe('daily digest publish', () => {
  it('rejects title-only pages and does not call OpenAI', async () => {
    const candidate = listedCandidate({
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      canonicalUrl: mustUrl('https://example.com/title-only'),
      title: 'タイトルだけ',
    })
    const openai = vi.fn(async () => {
      throw new Error('OpenAI should not run for title-only pages')
    })
    vi.stubGlobal('fetch', openai)
    const skipped = await summarizeDigestArticle(candidate, {
      OPENAI_API_KEY: 'sk-test',
      fetchPage: async (url) =>
        ok({
          requestedUrl: url,
          finalUrl: url,
          contentType: 'text/html',
          html: TITLE_ONLY_HTML,
        }),
    })
    expect(skipped).toEqual({ ok: false, error: { reason: 'title_only' } })
    expect(openai).not.toHaveBeenCalled()

    const { candidateStore, digestStore, store } = memoryDigest()
    await candidateStore.put(candidate)
    const result = await runDigest({
      store,
      candidateStore,
      digestStore,
      fetchPage: async (url) =>
        ok({
          requestedUrl: url,
          finalUrl: url,
          contentType: 'text/html',
          html: TITLE_ONLY_HTML,
        }),
      summarize: summarizeDigestArticle,
    })
    expect(result.status).toBe('empty')
    expect(result.skipped).toBe(1)
    expect(await store.listMeta()).toEqual([])
    expect(openai).not.toHaveBeenCalled()
  })

  it('evaluates unevaluated listed articles at deadline and then publishes', async () => {
    const { candidateStore, digestStore, store } = memoryDigest()
    const url = mustUrl('https://example.com/ja/workers-cpu')
    const html = readFileSync(join(root, 'fixtures', 'ja-tech.html'), 'utf8')
    await candidateStore.put(
      listedCandidate({
        id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        canonicalUrl: url,
        title: 'Cloudflare Workers の CPU 制限',
        recommendation: unevaluatedRecommendation(),
      }),
    )
    let jevCalls = 0
    const evaluateRecommend: EvaluateSystemOne = async () => {
      jevCalls += 1
      return {
        ok: true,
        value: {
          model: 'jev-test',
          answers: {
            recommendation: {
              type: 'choice',
              choice: 'recommended',
              confidence: 0.93,
              probabilities: { recommended: 0.93 },
            },
            de_relevant: { type: 'noul', noul: 0.9 },
            has_concreteness: { type: 'noul', noul: 0.8 },
            has_verification: { type: 'noul', noul: 0.7 },
          },
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      }
    }
    const result = await runDigest({
      store,
      candidateStore,
      digestStore,
      fetchPage: async (requested) =>
        ok({
          requestedUrl: requested,
          finalUrl: requested,
          contentType: 'text/html',
          html,
        }),
      evaluateRecommend,
      env: { ...TEST_BINDINGS, OPENROUTER_API_KEY: 'or-test' } as Cloudflare.Env,
    })
    expect(jevCalls).toBe(1)
    expect(result.status).toBe('published')
    expect(result.summarized).toBe(1)
    const judged = await candidateStore.getById(asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
    expect(judged?.recommendation.status).toBe('evaluated')
    expect(judged?.recommendation.grade).toBe('recommended')
    const chapter = epubChapter((await store.getEpub(result.articleId ?? asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))) ?? new Uint8Array())
    expect(chapter).toContain('Cloudflare Workers の CPU 制限')
    expect(chapter).toContain('https://example.com/ja/workers-cpu')
  })

  it('overwrites the same JST day instead of duplicating it', async () => {
    const { candidateStore, digestStore, store } = memoryDigest()
    const first = listedCandidate({
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      canonicalUrl: mustUrl('https://example.com/a'),
      title: '初回',
    })
    await candidateStore.put(first)
    const firstRun = await runDigest({ store, candidateStore, digestStore })
    await candidateStore.put({ ...first, title: '再実行' })
    const secondRun = await runDigest({ store, candidateStore, digestStore })
    expect(firstRun.status).toBe('published')
    expect(secondRun.status).toBe('published')
    expect(secondRun.articleId).toBe(firstRun.articleId)
    const listed = await store.listMeta()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.title).toBe('まとめ 2026-09-21')
    expect(epubChapter((await store.getEpub(listed[0]!.id)) ?? new Uint8Array())).toContain('再実行')
  })

  it('replaces yesterday, keeps clipped and purchased articles, and hides yesterday on empty or failed runs', async () => {
    const { candidateStore, digestStore, store } = memoryDigest()
    await store.put(clipWrite('クリップ記事'))
    await store.put(purchasedWrite('購入 EPUB'))
    await putYesterday(store)
    await candidateStore.put(
      listedCandidate({
        id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        canonicalUrl: mustUrl('https://example.com/today'),
        title: '本日の深掘り',
      }),
    )
    const published = await runDigest({ store, candidateStore, digestStore })
    expect(published.status).toBe('published')
    let titles = await sortedTitles(store)
    expect(titles).toEqual(['まとめ 2026-09-21', 'クリップ記事', '購入 EPUB'].sort())
    expect(titles).not.toContain('まとめ 2026-09-20')

    const emptyStore = createMemoryStore()
    await emptyStore.put(clipWrite('クリップ記事'))
    await emptyStore.put(purchasedWrite('購入 EPUB'))
    await putYesterday(emptyStore)
    const empty = await runDigest({
      store: emptyStore,
      candidateStore: createMemoryCandidateStore(),
      digestStore: createMemoryDigestStore(),
    })
    expect(empty.status).toBe('empty')
    titles = await sortedTitles(emptyStore)
    expect(titles).toEqual(['クリップ記事', '購入 EPUB'].sort())
    expect(titles.some((title) => title.startsWith('まとめ '))).toBe(false)

    const failingInner = createMemoryStore()
    await failingInner.put(clipWrite('クリップ記事'))
    await putYesterday(failingInner)
    const failingStore: ArticleStore = {
      ...failingInner,
      put: async () => {
        throw new Error('publish failed')
      },
    }
    const failed = await runDigest({
      store: failingStore,
      candidateStore,
      digestStore: createMemoryDigestStore(),
    })
    expect(failed.status).toBe('failed')
    titles = await sortedTitles(failingInner)
    expect(titles).toEqual(['クリップ記事'])
    expect(titles.some((title) => title.startsWith('まとめ '))).toBe(false)
  })

  it('does not republish an article from a past issue, but can select a newly discovered older article', async () => {
    const { candidateStore, digestStore, store } = memoryDigest()
    const reused = listedCandidate({
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      canonicalUrl: mustUrl('https://example.com/already-used'),
      title: '昨日の記事',
    })
    const freshOld = listedCandidate({
      id: asCandidateId('cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      canonicalUrl: mustUrl('https://example.com/old-but-new'),
      title: '昔の公開・新しい発見',
      publishedAt: '2025-01-02T00:00:00.000Z',
      discoveredAt: NOW.toISOString(),
    })
    await candidateStore.put(reused)
    await candidateStore.put(freshOld)
    await digestStore.replacePublishedItems(YESTERDAY, [
      {
        date: YESTERDAY,
        candidateId: reused.id,
        canonicalUrl: reused.canonicalUrl,
        title: reused.title,
      },
    ])
    const result = await runDigest({ store, candidateStore, digestStore })
    expect(result.status).toBe('published')
    const chapter = epubChapter(
      (await store.getEpub(result.articleId ?? asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))) ?? new Uint8Array(),
    )
    expect(chapter).toContain('昔の公開・新しい発見')
    expect(chapter).toContain('https://example.com/old-but-new')
    expect(chapter).not.toContain('昨日の記事')
    expect(chapter).not.toContain('https://example.com/already-used')
  })

  it('keeps the issue going when one article summary fails and does not use the clip queue', async () => {
    const { candidateStore, digestStore, store } = memoryDigest()
    const clip = createFakeQueue()
    const good = listedCandidate({
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      canonicalUrl: mustUrl('https://example.com/good'),
      title: '成功する記事',
    })
    const bad = listedCandidate({
      id: asCandidateId('cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      canonicalUrl: mustUrl('https://example.com/bad'),
      title: '失敗する記事',
      discoveredAt: '2026-09-21T00:00:00.000Z',
    })
    await candidateStore.put(good)
    await candidateStore.put(bad)
    const result = await runDailyDigest({ ...TEST_BINDINGS, CLIP_QUEUE: clip } as Cloudflare.Env, {
      date: TODAY,
      store,
      candidateStore,
      digestStore,
      fetchPage: unusedFetch,
      summarize: async (candidate) => {
        if (candidate.id === bad.id) {
          return { ok: false, error: { reason: 'summarize_failed' } }
        }
        return summarizeOk(candidate)
      },
      now: () => NOW,
    })
    expect(result.status).toBe('published')
    expect(result.summarized).toBe(1)
    expect(result.skipped).toBe(1)
    expect(clip.size).toBe(0)
    const chapter = epubChapter((await store.getEpub(result.articleId!)) ?? new Uint8Array())
    expect(chapter).toContain('成功する記事')
    expect(chapter).toContain(good.id)
    expect(chapter).not.toContain('失敗する記事')
  })
})

describe('daily digest HTTP', () => {
  it('queues a manual rerun with bearer auth and rejects missing credentials', async () => {
    const { clip, feed, digest } = queues()
    const app = createApp({ digestQueue: digest, queue: clip, now: () => NOW })
    const env = envWithQueues({ clip, feed, digest })
    const denied = await app.request('/digest', { method: 'POST' }, env)
    expect(denied.status).toBe(401)
    const queued = await app.request(
      '/digest',
      {
        method: 'POST',
        headers: { authorization: bearerAuthorization(), accept: 'application/json' },
      },
      env,
    )
    expect(queued.status).toBe(202)
    expect(await queued.json()).toEqual({ date: TODAY, status: 'queued' })
    expect(digest.peek()).toEqual([{ date: TODAY }])
    expect(clip.size).toBe(0)
  })
})
