import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { digestConfirmUrl, digestQrExpiresAt, signDigestQrToken } from '../../src/digest/confirm-link'
import { joinDigestInterest } from '../../src/digest/interest'
import { evaluatedRecommendation } from '../../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../../src/store/memory-candidates'
import { createMemoryDigestStore } from '../../src/store/memory-digest'
import { createMemoryStore } from '../../src/store/memory'
import { asCandidateId, parseHttpUrl, type CandidateArticle, type HttpUrl } from '../../src/types'
import { bearerAuthorization, TEST_BINDINGS } from '../bindings'
import { createFakeQueue } from '../fake-queue'
import { loggedText } from '../logged-text'

const ORIGIN = 'https://read.example.com'
const DATE = '2026-09-21'
const SECRET = 'clip-test-token-not-in-url'
const NOW = new Date('2026-09-21T03:00:00.000Z')
const LIKED = 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MISSED = 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function mustUrl(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function listed(id: string, url: string, title: string): CandidateArticle {
  const canonicalUrl = mustUrl(url)
  const now = NOW.toISOString()
  return {
    id: asCandidateId(id),
    canonicalUrl,
    sourceUrl: canonicalUrl,
    title,
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
      confidence: 0.9,
      model: 'test-model',
      excerptHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evaluatedAt: now,
      relevant: true,
      concrete: true,
      verification: true,
      inputTokens: 10,
      durationMs: 4,
    }),
    createdAt: now,
    updatedAt: now,
  }
}

describe('digest QR interest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats a QR confirm as a weak like and leaves other fetches unlabeled', async () => {
    const candidateStore = createMemoryCandidateStore()
    const digestStore = createMemoryDigestStore()
    const queue = createFakeQueue()
    const liked = listed(LIKED, 'https://alpha.example/post', 'QR で送る')
    const missed = listed(MISSED, 'https://beta.example/post', '別経路')
    await candidateStore.put(liked)
    await candidateStore.put(missed)
    await digestStore.replacePublishedItems(DATE, [
      { date: DATE, candidateId: liked.id, canonicalUrl: liked.canonicalUrl, title: liked.title },
      { date: DATE, candidateId: missed.id, canonicalUrl: missed.canonicalUrl, title: missed.title },
    ])
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(loggedText(message))
    })
    const app = createApp({
      store: createMemoryStore(),
      candidateStore,
      digestStore,
      queue,
      now: () => NOW,
    })
    const env = { ...TEST_BINDINGS, CLIP_TOKEN: SECRET, PUBLIC_ORIGIN: ORIGIN, CLIP_QUEUE: queue } as Cloudflare.Env
    const expiresAt = digestQrExpiresAt(DATE)
    const token = await signDigestQrToken({ secret: SECRET, candidateId: LIKED, expiresAt })
    const url = digestConfirmUrl(ORIGIN, LIKED, expiresAt, token)

    const viewed = await app.request(url, { method: 'GET' }, env)
    expect(viewed.status).toBe(200)
    const viewedHtml = await viewed.text()
    expect(viewedHtml).toContain('全文を送る')
    expect(viewedHtml).toContain('この画面を開いただけでは送信しません')

    const sent = await app.request(url, { method: 'POST' }, env)
    expect(sent.status).toBe(200)
    expect(await sent.text()).toContain('全文の準備を開始しました')
    expect(queue.size).toBe(1)

    const clip = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(SECRET),
        },
        body: JSON.stringify({ url: missed.canonicalUrl }),
      },
      env,
    )
    expect(clip.status).toBe(202)
    const fromList = await app.request(
      `/candidates/${MISSED}/clip`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(SECRET),
        },
        body: JSON.stringify({}),
      },
      env,
    )
    expect(fromList.status).toBe(202)

    const labels = joinDigestInterest(await digestStore.listInterestSnapshot())
    expect(labels.map((item) => ({ id: item.candidateId, label: item.label }))).toEqual([
      { id: liked.id, label: 'weak_positive' },
      { id: missed.id, label: 'ordinary_or_below' },
    ])
    const joined = logs.join('\n')
    expect(joined).toContain('digest_interest')
    expect(joined).toContain('weak_positive')
    expect(joined).not.toContain(SECRET)
    expect(joined).not.toContain(token)
    expect(joined).not.toContain(liked.canonicalUrl)
  })
})
