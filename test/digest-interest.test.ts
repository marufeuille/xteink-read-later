import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import {
  digestConfirmUrl,
  digestQrExpiresAt,
  issueDateFromDigestQrExpires,
  signDigestQrToken,
} from '../src/digest/confirm-link'
import {
  digestQrWindowOpen,
  digestSourceInterestPrior,
  joinDigestInterest,
  type DigestSourceInterest,
} from '../src/digest/interest'
import { selectDigestCandidates } from '../src/daily/select'
import { evaluatedRecommendation, unevaluatedRecommendation } from '../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryDigestStore } from '../src/store/memory-digest'
import { createMemoryStore } from '../src/store/memory'
import {
  asCandidateId,
  parseHttpUrl,
  type CandidateArticle,
  type DigestInterestSnapshot,
  type HttpUrl,
} from '../src/types'
import { bearerAuthorization, TEST_BINDINGS } from './bindings'
import { createFakeQueue } from './fake-queue'
import { loggedText } from './logged-text'

const ORIGIN = 'https://read.example.com'
const DATE = '2026-09-21'
const OTHER_DATE = '2026-09-22'
const SECRET = 'clip-test-token-not-in-url'
const NOW = new Date('2026-09-21T03:00:00.000Z')
const LIKED = 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MISSED = 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OUTSIDER = 'cand_cccccccccccccccccccccccccccccccc'

function mustUrl(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function listed(
  overrides: Partial<CandidateArticle> & Pick<CandidateArticle, 'id' | 'canonicalUrl'>,
): CandidateArticle {
  const now = NOW.toISOString()
  return {
    sourceUrl: overrides.canonicalUrl,
    title: '記事',
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
    ...overrides,
  }
}

function snapshot(
  published: DigestInterestSnapshot['published'],
  fetches: DigestInterestSnapshot['fetches'] = [],
): DigestInterestSnapshot {
  return { published, fetches }
}

function published(id: string, url: string, date = DATE, title = id) {
  return {
    date,
    candidateId: asCandidateId(id),
    canonicalUrl: mustUrl(url),
    title,
  }
}

describe('digest QR interest join', () => {
  it('maps a signed expiry back to that issue date only', () => {
    const expiresAt = digestQrExpiresAt(DATE)
    expect(issueDateFromDigestQrExpires(expiresAt)).toBe(DATE)
    expect(issueDateFromDigestQrExpires(expiresAt + 1)).toBeNull()
    expect(issueDateFromDigestQrExpires(expiresAt - 1)).toBeNull()
    expect(issueDateFromDigestQrExpires(-1)).toBeNull()
  })

  it('labels QR fetches inside the issue and ignores fetches outside it', () => {
    const labels = joinDigestInterest(
      snapshot(
        [published(LIKED, 'https://alpha.example/post'), published(MISSED, 'https://beta.example/post')],
        [
          {
            issueDate: DATE,
            candidateId: asCandidateId(LIKED),
            fetchedAt: '2026-09-21T04:00:00.000Z',
          },
          {
            issueDate: OTHER_DATE,
            candidateId: asCandidateId(MISSED),
            fetchedAt: '2026-09-22T04:00:00.000Z',
          },
          {
            issueDate: DATE,
            candidateId: asCandidateId(OUTSIDER),
            fetchedAt: '2026-09-21T05:00:00.000Z',
          },
        ],
      ),
    )
    expect(labels).toEqual([
      expect.objectContaining({
        candidateId: LIKED,
        label: 'weak_positive',
        fetchedAt: '2026-09-21T04:00:00.000Z',
      }),
      expect.objectContaining({
        candidateId: MISSED,
        label: 'ordinary_or_below',
        fetchedAt: null,
      }),
    ])
    expect(labels).toHaveLength(2)
  })

  it('keeps an open miss at zero and clamps a closed miss to a weak downrank', () => {
    const openNow = NOW.getTime()
    expect(digestQrWindowOpen(DATE, openNow)).toBe(true)
    expect(digestQrWindowOpen('2026-08-01', openNow)).toBe(false)
    const open = digestSourceInterestPrior(
      joinDigestInterest(
        snapshot([
          published(LIKED, 'https://alpha.example/open', DATE),
          published(MISSED, 'https://beta.example/open', DATE),
        ]),
      ),
      openNow,
    )
    expect(open.has('alpha.example')).toBe(false)
    expect(open.has('beta.example')).toBe(false)

    const closed = digestSourceInterestPrior(
      joinDigestInterest(
        snapshot(
          [
            published(LIKED, 'https://alpha.example/old', '2026-08-01'),
            ...Array.from({ length: 5 }, (_, index) =>
              published(
                `cand_${String(index + 1).padStart(32, 'd')}`,
                `https://miss.example/old-${index}`,
                '2026-08-01',
              ),
            ),
          ],
          [
            {
              issueDate: '2026-08-01',
              candidateId: asCandidateId(LIKED),
              fetchedAt: '2026-08-01T01:00:00.000Z',
            },
          ],
        ),
      ),
      openNow,
    )
    expect(closed.get('alpha.example')).toBe(1)
    expect(closed.get('miss.example')).toBe(-1)
  })

  it('does not mix Zenn authors into one site signal', () => {
    const priors = digestSourceInterestPrior(
      joinDigestInterest(
        snapshot(
          [
            published(LIKED, 'https://zenn.dev/alice/articles/pipeline', '2026-08-01'),
            published(MISSED, 'https://zenn.dev/bob/articles/notes', '2026-08-01'),
          ],
          [
            {
              issueDate: '2026-08-01',
              candidateId: asCandidateId(LIKED),
              fetchedAt: '2026-08-02T00:00:00.000Z',
            },
          ],
        ),
      ),
      NOW.getTime(),
    )
    expect(priors.get('zenn.dev/alice')).toBe(1)
    expect(priors.get('zenn.dev/bob')).toBe(-1)
    expect(priors.has('zenn.dev')).toBe(false)
  })

  it('uses the prior only as a tie-break and still keeps a downranked site', () => {
    const older = listed({
      id: asCandidateId(LIKED),
      canonicalUrl: mustUrl('https://alpha.example/new'),
      title: 'alpha',
      discoveredAt: '2026-09-20T00:00:00.000Z',
    })
    const newer = listed({
      id: asCandidateId(MISSED),
      canonicalUrl: mustUrl('https://beta.example/new'),
      title: 'beta',
      discoveredAt: '2026-09-21T00:00:00.000Z',
    })
    const plain = selectDigestCandidates([older, newer], { usedCanonicalUrls: new Set() })
    expect(plain.map((item) => item.title)).toEqual(['beta', 'alpha'])
    const boosted = selectDigestCandidates([older, newer], {
      usedCanonicalUrls: new Set(),
      sourceInterest: new Map<string, DigestSourceInterest>([['alpha.example', 1]]),
    })
    expect(boosted.map((item) => item.title)).toEqual(['alpha', 'beta'])
    const confident = listed({
      ...newer,
      recommendation: evaluatedRecommendation({
        grade: 'recommended',
        confidence: 0.99,
        model: 'test-model',
        excerptHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        evaluatedAt: NOW.toISOString(),
        relevant: true,
        concrete: true,
        verification: true,
        inputTokens: 10,
        durationMs: 4,
      }),
    })
    const confidenceWins = selectDigestCandidates([older, confident], {
      usedCanonicalUrls: new Set(),
      sourceInterest: new Map<string, DigestSourceInterest>([['alpha.example', 1]]),
    })
    expect(confidenceWins.map((item) => item.title)).toEqual(['beta', 'alpha'])
    const onlyDownranked = selectDigestCandidates([newer], {
      usedCanonicalUrls: new Set(),
      sourceInterest: new Map<string, DigestSourceInterest>([['beta.example', -1]]),
    })
    expect(onlyDownranked.map((item) => item.id)).toEqual([newer.id])
  })

  it('keeps the first QR fetch when the issue is republished and drops it when the candidate leaves', async () => {
    const store = createMemoryDigestStore()
    const liked = published(LIKED, 'https://alpha.example/post', DATE, '好き')
    const missed = published(MISSED, 'https://beta.example/post', DATE, '未取得')
    await store.replacePublishedItems(DATE, [liked, missed])
    expect(
      await store.recordPublishedQrFetch({
        issueDate: DATE,
        candidateId: asCandidateId(OUTSIDER),
        fetchedAt: NOW.toISOString(),
      }),
    ).toBe('not_published')
    expect(
      await store.recordPublishedQrFetch({
        issueDate: OTHER_DATE,
        candidateId: asCandidateId(LIKED),
        fetchedAt: NOW.toISOString(),
      }),
    ).toBe('not_published')
    expect(
      await store.recordPublishedQrFetch({
        issueDate: DATE,
        candidateId: liked.candidateId,
        fetchedAt: '2026-09-21T04:00:00.000Z',
      }),
    ).toBe('recorded')
    expect(
      await store.recordPublishedQrFetch({
        issueDate: DATE,
        candidateId: liked.candidateId,
        fetchedAt: '2026-09-21T05:00:00.000Z',
      }),
    ).toBe('already_recorded')
    await store.replacePublishedItems(DATE, [liked, missed])
    const kept = joinDigestInterest(await store.listInterestSnapshot())
    expect(kept.find((item) => item.candidateId === liked.candidateId)?.fetchedAt).toBe(
      '2026-09-21T04:00:00.000Z',
    )
    await store.replacePublishedItems(DATE, [missed])
    const removed = joinDigestInterest(await store.listInterestSnapshot())
    expect(removed.map((item) => item.candidateId)).toEqual([missed.candidateId])
    expect(removed[0]?.label).toBe('ordinary_or_below')
    expect((await store.listInterestSnapshot()).fetches).toHaveLength(1)
  })
})

describe('digest QR interest HTTP', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function confirmUrl(candidateId: string, issueDate = DATE): Promise<string> {
    const expiresAt = digestQrExpiresAt(issueDate)
    const token = await signDigestQrToken({ secret: SECRET, candidateId, expiresAt })
    return digestConfirmUrl(ORIGIN, candidateId, expiresAt, token)
  }

  function interestEvents(logs: readonly string[]): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = []
    for (const line of logs) {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (record.event === 'digest_interest') {
          events.push(record)
        }
      }
    }
    return events
  }

  it('records a weak positive only for that issue after POST, not for other fetch paths', async () => {
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const digestStore = createMemoryDigestStore()
    const queue = createFakeQueue()
    const liked = listed({
      id: asCandidateId(LIKED),
      canonicalUrl: mustUrl('https://alpha.example/post'),
      title: 'QR で送る',
    })
    const missed = listed({
      id: asCandidateId(MISSED),
      canonicalUrl: mustUrl('https://beta.example/post'),
      title: '一覧から送る',
    })
    const outsider = listed({
      id: asCandidateId(OUTSIDER),
      canonicalUrl: mustUrl('https://gamma.example/post'),
      title: '号に無い',
      recommendation: unevaluatedRecommendation(),
    })
    await candidateStore.put(liked)
    await candidateStore.put(missed)
    await candidateStore.put(outsider)
    await digestStore.replacePublishedItems(DATE, [
      published(LIKED, liked.canonicalUrl, DATE, liked.title),
      published(MISSED, missed.canonicalUrl, DATE, missed.title),
    ])
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(loggedText(message))
    })
    const app = createApp({
      store,
      candidateStore,
      digestStore,
      queue,
      now: () => NOW,
    })
    const env = { ...TEST_BINDINGS, CLIP_TOKEN: SECRET, PUBLIC_ORIGIN: ORIGIN, CLIP_QUEUE: queue } as Cloudflare.Env
    const url = await confirmUrl(LIKED)
    const viewed = await app.request(url, { method: 'GET' }, env)
    expect(viewed.status).toBe(200)
    expect(await viewed.text()).toContain('この画面を開いただけでは送信しません')
    expect(interestEvents(logs)).toEqual([])

    const sent = await app.request(url, { method: 'POST' }, env)
    expect(sent.status).toBe(200)
    const again = await app.request(url, { method: 'POST' }, env)
    expect(again.status).toBe(200)
    const wrongIssue = await app.request(await confirmUrl(LIKED, OTHER_DATE), { method: 'POST' }, env)
    expect(wrongIssue.status).toBe(200)
    const notInIssue = await app.request(await confirmUrl(OUTSIDER), { method: 'POST' }, env)
    expect(notInIssue.status).toBe(200)

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
    expect(labels).toEqual([
      expect.objectContaining({
        candidateId: LIKED,
        label: 'weak_positive',
        fetchedAt: NOW.toISOString(),
      }),
      expect.objectContaining({ candidateId: MISSED, label: 'ordinary_or_below', fetchedAt: null }),
    ])
    const events = interestEvents(logs)
    expect(events.map((event) => event.result)).toEqual([
      'recorded',
      'already_recorded',
      'ignored',
      'ignored',
    ])
    expect(events[0]).toMatchObject({ label: 'weak_positive', issueDate: DATE, candidateId: LIKED })
    expect(events[2]).toMatchObject({ reason: 'not_in_issue', issueDate: OTHER_DATE, candidateId: LIKED })
    expect(events[3]).toMatchObject({ reason: 'not_in_issue', issueDate: DATE, candidateId: OUTSIDER })
    const joined = logs.join('\n')
    expect(joined).not.toContain(SECRET)
    expect(joined).not.toContain(liked.canonicalUrl)
    expect(joined).not.toContain(missed.canonicalUrl)
    expect(events[0]?.message).toBe('digest_interest recorded weak_positive')
  })

  it('does not record a like when the confirm send fails', async () => {
    const candidateStore = createMemoryCandidateStore()
    const digestStore = createMemoryDigestStore()
    const queue = createFakeQueue({
      onSend() {
        throw new Error('queue down')
      },
    })
    const liked = listed({
      id: asCandidateId(LIKED),
      canonicalUrl: mustUrl('https://alpha.example/post'),
      title: '送れない',
    })
    await candidateStore.put(liked)
    await digestStore.replacePublishedItems(DATE, [published(LIKED, liked.canonicalUrl, DATE, liked.title)])
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
    const env = { ...TEST_BINDINGS, CLIP_TOKEN: SECRET, CLIP_QUEUE: queue } as Cloudflare.Env
    const sent = await app.request(await confirmUrl(LIKED), { method: 'POST' }, env)
    expect(sent.status).toBe(503)
    expect(interestEvents(logs)).toEqual([])
    expect((await digestStore.listInterestSnapshot()).fetches).toEqual([])
  })
})
