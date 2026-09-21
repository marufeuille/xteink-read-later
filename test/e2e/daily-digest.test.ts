import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { buildDummyDailyWrite } from '../../src/daily/issue'
import { publishLatestDaily } from '../../src/daily/publish'
import { handleScheduled } from '../../src/schedule'
import { unavailableClassification } from '../../src/classify/taxonomy'
import { evaluatedRecommendation } from '../../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryDigestStore } from '../../src/store/memory-digest'
import { createMemoryStore } from '../../src/store/memory'
import {
  asArticleId,
  asCandidateId,
  asEpubBytes,
  DAILY_DIGEST_CRON,
  parseHttpUrl,
  type CandidateArticle,
  type HttpUrl,
} from '../../src/types'
import { basicAuthorization, TEST_BINDINGS } from '../bindings'
import { createFakeDigestQueue } from '../fake-digest-queue'
import { createFakeFeedQueue } from '../fake-feed-queue'
import { createFakeQueue } from '../fake-queue'
import { installNetworkMock, openaiMessageResponse } from './mock-network'

const ORIGIN = mustUrl('https://read.example.com')
const TODAY = '2026-09-21'
const NOW = new Date('2026-09-21T03:00:00.000Z')

function mustUrl(value: string): HttpUrl {
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

function articleHtml(url: string, title: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><title>${title}</title><link rel="canonical" href="${url}" /></head>
<body><article><h1>${title}</h1>
<p>${title} の本文です。データ基盤の設計と運用について、パイプラインの検証手順まで踏み込みます。</p>
<p>二段落目も入れて最小文字数を超えます。Cloudflare Workers と D1 の組み合わせ。</p>
<p>三段落目で抽出が安定するようにします。</p>
</article></body></html>`
}

function listed(input: {
  readonly id: string
  readonly url: string
  readonly title: string
}): CandidateArticle {
  const canonicalUrl = mustUrl(input.url)
  const now = NOW.toISOString()
  return {
    id: asCandidateId(input.id),
    canonicalUrl,
    sourceUrl: canonicalUrl,
    title: input.title,
    outlet: 'example.com',
    publishedAt: '2026-09-20T00:00:00.000Z',
    discoveredAt: now,
    fetchStatus: 'fetched',
    listingState: 'listed',
    exclusionReason: null,
    fullTextState: 'confirmed_free',
    completedArticleId: null,
    clipJobId: null,
    clipRunId: null,
    selectedAt: null,
    recommendation: evaluatedRecommendation({
      grade: 'recommended',
      confidence: 0.94,
      model: 'test-model',
      excerptHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evaluatedAt: now,
      relevant: true,
      concrete: true,
      verification: true,
      inputTokens: 20,
      durationMs: 10,
    }),
    createdAt: now,
    updatedAt: now,
  }
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('daily digest fixture e2e', () => {
  it('publishes only today’s digest to OPDS after the aggregation cron', async () => {
    const todayUrl = 'https://example.com/deep-pipeline'
    installNetworkMock({
      pages: {
        [todayUrl]: { html: articleHtml(todayUrl, 'パイプラインの深い話') },
      },
      openai: async () => openaiMessageResponse('unused', '日本語の要約です。設計と運用の要点だけを残します。'),
    })
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const digestStore = createMemoryDigestStore()
    const { clip, feed, digest } = queues()
    await store.put({
      id: asArticleId('art_dddddddddddddddddddddddddddddddd'),
      title: 'クリップ記事',
      author: null,
      publishedAt: null,
      sourceUrl: mustUrl('https://example.com/kept'),
      canonicalUrl: mustUrl('https://example.com/kept'),
      language: 'ja',
      translated: false,
      classification: unavailableClassification('skipped'),
      epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])),
    })
    const yesterday = await buildDummyDailyWrite({
      date: '2026-09-20',
      origin: ORIGIN,
      bodyMarker: 'DAY-2026-09-20',
    })
    await publishLatestDaily(store, yesterday.write)
    await candidateStore.put(
      listed({
        id: 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        url: todayUrl,
        title: 'パイプラインの深い話',
      }),
    )

    const env = envWithQueues({ clip, feed, digest })
    const scheduled = await handleScheduled({ cron: DAILY_DIGEST_CRON }, env, {
      digestQueue: digest,
      now: () => NOW,
    })
    expect(scheduled).toMatchObject({ kind: 'daily_digest', queued: 1, failed: 0 })
    expect(feed.size).toBe(0)
    expect(clip.size).toBe(0)

    await digest.drain(env, {
      store,
      candidateStore,
      digestStore,
      now: () => NOW,
    })
    expect(clip.size).toBe(0)

    const app = createApp({ store })
    const catalog = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization() } },
      env,
    )
    expect(catalog.status).toBe(200)
    const xml = await catalog.text()
    expect(xml).toContain('まとめ 2026-09-21')
    expect(xml).toContain('https://read.example.com/opds/clip')
    expect(xml).not.toContain('クリップ記事')
    expect(xml).not.toContain('まとめ 2026-09-20')
    const clipShelf = await app.request(
      'https://read.example.com/opds/clip',
      { headers: { authorization: basicAuthorization() } },
      env,
    )
    expect(clipShelf.status).toBe(200)
    const clipXml = await clipShelf.text()
    const clipDate = /href="(https:\/\/read\.example\.com\/opds\/clip\/\d{4}-\d{2}-\d{2})"/.exec(clipXml)?.[1]
    expect(clipDate).toBeDefined()
    const clipDay = await app.request(clipDate ?? '', { headers: { authorization: basicAuthorization() } }, env)
    expect(await clipDay.text()).toContain('クリップ記事')
    expect(xml).not.toContain(yesterday.identity.opdsEntryId)

    const listedMeta = await store.listMeta()
    const todayMeta = listedMeta.find((item) => item.title === `まとめ ${TODAY}`)
    expect(todayMeta).toBeDefined()
    const epub = (await store.getEpub(todayMeta!.id)) ?? new Uint8Array()
    const body = chapter(epub)
    expect(body).toContain('パイプラインの深い話')
    expect(body).toContain(todayUrl)
    expect(body).toContain('日本語の要約です')
    expect(body).not.toContain('DAY-2026-09-20')
  })
})
