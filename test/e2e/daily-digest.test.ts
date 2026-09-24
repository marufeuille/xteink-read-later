import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { digestConfirmUrl, digestQrExpiresAt, signDigestQrToken } from '../../src/digest/confirm-link'
import { qrPng } from '../../src/digest/qr-png'
import { buildDummyDailyWrite } from '../../src/daily/issue'
import { publishLatestDaily } from '../../src/daily/publish'
import { handleScheduled } from '../../src/schedule'
import { unavailableClassification } from '../../src/classify/taxonomy'
import { evaluatedRecommendation } from '../../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryDigestStore } from '../../src/store/memory-digest'
import { createMemoryFeedSourceStore } from '../../src/store/memory-sources'
import { createMemoryStore } from '../../src/store/memory'
import {
  articleIdFromCanonicalUrl,
  asArticleId,
  asCandidateId,
  asEpubBytes,
  DAILY_DIGEST_CRON,
  parseHttpUrl,
  type CandidateArticle,
  type HttpUrl,
} from '../../src/types'
import { basicAuthorization, bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from '../bindings'
import { createFakeDigestQueue } from '../fake-digest-queue'
import { createFakeFeedQueue } from '../fake-feed-queue'
import { createFakeQueue } from '../fake-queue'
import { readRgbPng } from '../png-file'
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

function epubFiles(epub: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(epub)
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
  readonly recommendation?: CandidateArticle['recommendation']
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
    recommendation:
      input.recommendation ??
      evaluatedRecommendation({
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
    const secondUrl = 'https://example.com/related-note'
    installNetworkMock({
      pages: {
        [todayUrl]: { html: articleHtml(todayUrl, 'パイプラインの深い話') },
        [secondUrl]: { html: articleHtml(secondUrl, '関連する実装メモ') },
      },
      openai: async (request) => {
        const body = (await request.json()) as { messages?: { content?: string }[] }
        const user = JSON.parse(body.messages?.[1]?.content ?? '{}') as { maxChars?: number }
        expect(user.maxChars).toBe(400)
        return openaiMessageResponse('unused', '日本語の要約です。設計と運用の要点だけを残します。')
      },
    })
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const digestStore = createMemoryDigestStore()
    const { clip, feed, digest } = queues()
    const keptEpub = asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    const keptId = asArticleId('art_dddddddddddddddddddddddddddddddd')
    await store.put({
      id: keptId,
      title: 'クリップ記事',
      author: null,
      publishedAt: null,
      sourceUrl: mustUrl('https://example.com/kept'),
      canonicalUrl: mustUrl('https://example.com/kept'),
      language: 'ja',
      translated: false,
      classification: unavailableClassification('skipped'),
      epub: keptEpub,
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
    await candidateStore.put(
      listed({
        id: 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        url: secondUrl,
        title: '関連する実装メモ',
        recommendation: evaluatedRecommendation({
          grade: 'related',
          confidence: 0.9,
          model: 'test-model',
          excerptHash: 'cccccccccccccccccccccccccccccccc',
          evaluatedAt: NOW.toISOString(),
          relevant: true,
          concrete: false,
          verification: false,
          inputTokens: 20,
          durationMs: 10,
        }),
      }),
    )

    const env = {
      ...envWithQueues({ clip, feed, digest }),
      PUBLIC_ORIGIN: 'https://read.example.com',
    }
    const scheduled = await handleScheduled({ cron: DAILY_DIGEST_CRON }, env, {
      sourceStore: createMemoryFeedSourceStore(),
      feedQueue: feed,
      digestQueue: digest,
      now: () => NOW,
    })
    expect(scheduled).toMatchObject({
      kinds: ['feed_collect', 'daily_digest'],
      queued: 1,
      failed: 0,
    })
    expect(feed.size).toBe(0)
    expect(clip.size).toBe(0)

    await digest.drain(env, {
      store,
      candidateStore,
      digestStore,
      now: () => NOW,
    })
    expect(clip.size).toBe(0)

    const app = createApp({ store, candidateStore, queue: clip, now: () => NOW })
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
    expect(body).toContain('関連する実装メモ')
    expect(body).toContain(todayUrl)
    expect(body).toContain('日本語の要約です')
    expect(body).not.toContain('DAY-2026-09-20')
    const files = epubFiles(epub)
    const pngs = Object.keys(files).filter((name) => name.endsWith('.png')).sort()
    expect(pngs).toEqual([
      'OEBPS/images/qr-cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      'OEBPS/images/qr-cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
    ])
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    expect(opf.match(/media-type="image\/png"/g)).toHaveLength(2)
    const kept = (await store.getEpub(keptId)) ?? new Uint8Array()
    expect(Buffer.from(kept).equals(Buffer.from(keptEpub))).toBe(true)

    const expiresAt = digestQrExpiresAt(TODAY)
    const token = await signDigestQrToken({
      secret: TEST_CLIP_TOKEN,
      candidateId: 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expiresAt,
    })
    const confirm = digestConfirmUrl('https://read.example.com', 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', expiresAt, token)
    const png = files['OEBPS/images/qr-cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'] ?? new Uint8Array()
    expect(Buffer.from(png).equals(Buffer.from(qrPng(confirm)))).toBe(true)
    const decoded = readRgbPng(png)
    expect(decoded.colorType).toBe(2)
    expect(decoded.interlace).toBe(0)
    expect(decoded.rowFilter).toBe(0)
    expect(decoded.firstPixel).toEqual([255, 255, 255])
    expect(decoded.hasBlack).toBe(true)
    const other = readRgbPng(files['OEBPS/images/qr-cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png'] ?? new Uint8Array())
    expect(other.hasBlack).toBe(true)
    expect(body).not.toContain(token)
    expect(body).not.toContain(TEST_CLIP_TOKEN)

    const viewed = await app.request(confirm, { method: 'GET' }, env)
    expect(viewed.status).toBe(200)
    expect(await viewed.text()).toContain('全文を送る')
    expect(clip.size).toBe(0)
    const sent = await app.request(confirm, { method: 'POST' }, env)
    expect(sent.status).toBe(200)
    expect(await sent.text()).toContain('全文の準備を開始しました')
    expect(clip.size).toBe(1)

    const tampered = `${confirm.slice(0, -1)}${confirm.endsWith('a') ? 'b' : 'a'}`
    const rejected = await app.request(tampered, { method: 'POST' }, env)
    expect(rejected.status).toBe(403)
    expect(clip.size).toBe(1)

    const expiredAt = digestQrExpiresAt('2026-09-01')
    const expiredToken = await signDigestQrToken({
      secret: TEST_CLIP_TOKEN,
      candidateId: 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAt: expiredAt,
    })
    const expired = await app.request(
      digestConfirmUrl('https://read.example.com', 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', expiredAt, expiredToken),
      { method: 'POST' },
      env,
    )
    expect(expired.status).toBe(403)
    expect(await expired.text()).toContain('期限が切れています')
    expect(clip.size).toBe(1)

    const secondUrlParsed = mustUrl(secondUrl)
    const finishedId = await articleIdFromCanonicalUrl(secondUrlParsed)
    await store.put({
      id: finishedId,
      title: '関連する実装メモ',
      author: null,
      publishedAt: null,
      sourceUrl: secondUrlParsed,
      canonicalUrl: secondUrlParsed,
      language: 'ja',
      translated: false,
      epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 4])),
    })
    const finishedToken = await signDigestQrToken({
      secret: TEST_CLIP_TOKEN,
      candidateId: 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAt,
    })
    const finished = await app.request(
      digestConfirmUrl(
        'https://read.example.com',
        'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        expiresAt,
        finishedToken,
      ),
      { method: 'POST' },
      env,
    )
    expect(finished.status).toBe(200)
    expect(await finished.text()).toContain('新しい生成は始めません')
    expect(clip.size).toBe(1)
  })

  it('queues a digest from the sources form without starting a clip', async () => {
    const { clip, feed, digest } = queues()
    const app = createApp({
      store: createMemoryStore(),
      queue: clip,
      feedQueue: feed,
      digestQueue: digest,
      now: () => NOW,
    })
    const env = envWithQueues({ clip, feed, digest })
    const posted = await app.request(
      '/digest',
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: '',
      },
      env,
    )
    expect(posted.status).toBe(303)
    expect(posted.headers.get('location')).toBe('/sources?notice=digest_queued')
    expect(digest.peek()).toEqual([{ date: TODAY }])
    expect(clip.size).toBe(0)
    expect(feed.size).toBe(0)
  })
})
