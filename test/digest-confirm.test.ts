import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import {
  digestConfirmUrl,
  digestQrExpiresAt,
  signDigestQrToken,
  verifyDigestQrToken,
  workerPublicOrigin,
} from '../src/digest/confirm-link'
import { qrJpeg } from '../src/digest/qr-jpeg'
import { buildDummyDailyWrite, buildDailyDigestWrite } from '../src/daily/issue'
import { runDailyDigest } from '../src/daily/run'
import { evaluatedRecommendation, unevaluatedRecommendation } from '../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryDigestStore } from '../src/store/memory-digest'
import { createMemoryStore } from '../src/store/memory'
import {
  articleIdFromCanonicalUrl,
  asCandidateId,
  asEpubBytes,
  clipJobIdFromUrl,
  ok,
  parseHttpUrl,
  type CandidateArticle,
  type DigestPreparedItem,
  type HttpUrl,
} from '../src/types'
import { TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'
import { loggedText } from './logged-text'
import { createFakeQueue } from './fake-queue'
import { readQrJpeg } from './qr-jpeg'

const ORIGIN = 'https://read.example.com'
const DATE = '2026-09-21'
const SECRET = 'clip-test-token-not-in-url'
const NOW = new Date('2026-09-21T03:00:00.000Z')
const CANDIDATE_A = 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CANDIDATE_B = 'cand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function mustUrl(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function item(id: string, title: string, summary = '<p>要約です。</p>'): DigestPreparedItem {
  const canonicalUrl = mustUrl(`https://example.com/${id}`)
  return {
    candidateId: asCandidateId(id),
    canonicalUrl,
    title,
    summaryHtml: summary,
  }
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
    recommendation: unevaluatedRecommendation(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function epubParts(epub: Uint8Array): {
  readonly opf: string
  readonly chapter: string
  readonly chapters: readonly string[]
  readonly jpgs: string[]
} {
  const files = unzipSync(epub)
  const sectionNames = Object.keys(files)
    .filter((name) => /^OEBPS\/section-\d+\.xhtml$/.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  const chapterNames = sectionNames.length > 0 ? sectionNames : ['OEBPS/chapter.xhtml']
  const chapters = chapterNames.map((name) => strFromU8(files[name] ?? new Uint8Array()))
  return {
    opf: strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array()),
    chapter: chapters.join('\n'),
    chapters,
    jpgs: Object.keys(files).filter((name) => name.endsWith('.jpg')).sort(),
  }
}

async function confirmUrl(candidateId: string, secret = SECRET): Promise<string> {
  const expiresAt = digestQrExpiresAt(DATE)
  const token = await signDigestQrToken({ secret, candidateId, expiresAt })
  return digestConfirmUrl(ORIGIN, candidateId, expiresAt, token)
}

describe('digest QR token', () => {
  it('expires 14 days after the issue date and stays stable for that date', async () => {
    const expiresAt = digestQrExpiresAt(DATE)
    expect(expiresAt).toBe(Math.floor(Date.parse('2026-10-05T00:00:00+09:00') / 1000))
    const first = await signDigestQrToken({ secret: SECRET, candidateId: CANDIDATE_A, expiresAt })
    const second = await signDigestQrToken({ secret: SECRET, candidateId: CANDIDATE_A, expiresAt })
    expect(second).toBe(first)
    const other = await signDigestQrToken({
      secret: SECRET,
      candidateId: CANDIDATE_B,
      expiresAt,
    })
    expect(other).not.toBe(first)
    const url = digestConfirmUrl(ORIGIN, CANDIDATE_A, expiresAt, first)
    expect(url).not.toContain(SECRET)
    expect(url).not.toContain('CLIP_TOKEN')
  })

  it('rejects an expired token and a tampered token', async () => {
    const expiresAt = digestQrExpiresAt(DATE)
    const token = await signDigestQrToken({ secret: SECRET, candidateId: CANDIDATE_A, expiresAt })
    const valid = await verifyDigestQrToken({
      secret: SECRET,
      candidateId: CANDIDATE_A,
      expiresAt: String(expiresAt),
      token,
      nowMs: expiresAt * 1000 - 1,
    })
    expect(valid.ok).toBe(true)
    const expired = await verifyDigestQrToken({
      secret: SECRET,
      candidateId: CANDIDATE_A,
      expiresAt: String(expiresAt),
      token,
      nowMs: expiresAt * 1000,
    })
    expect(expired).toEqual({ ok: false, reason: 'expired' })
    const tampered = await verifyDigestQrToken({
      secret: SECRET,
      candidateId: CANDIDATE_A,
      expiresAt: String(expiresAt),
      token: `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`,
      nowMs: expiresAt * 1000 - 1,
    })
    expect(tampered).toEqual({ ok: false, reason: 'invalid' })
    const swapped = await verifyDigestQrToken({
      secret: SECRET,
      candidateId: CANDIDATE_B,
      expiresAt: String(expiresAt),
      token,
      nowMs: expiresAt * 1000 - 1,
    })
    expect(swapped).toEqual({ ok: false, reason: 'invalid' })
  })

  it('accepts only an origin without a path', () => {
    expect(workerPublicOrigin('https://read.example.com/')).toBe('https://read.example.com')
    expect(workerPublicOrigin(' https://read.example.com ')).toBe('https://read.example.com')
    expect(workerPublicOrigin('https://read.example.com/opds')).toBeNull()
    expect(workerPublicOrigin('https://user:secret@read.example.com')).toBeNull()
    expect(workerPublicOrigin('')).toBeNull()
    expect(workerPublicOrigin(undefined)).toBeNull()
  })
})

describe('digest QR jpeg', () => {
  it('is a baseline JPEG inside the X3 box and is deterministic', () => {
    const first = qrJpeg('https://read.example.com/digest/send/example')
    const second = qrJpeg('https://read.example.com/digest/send/example')
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const header = readQrJpeg(first)
    expect(header.width).toBe(header.height)
    expect(header.width).toBeGreaterThanOrEqual(24)
    expect(header.width).toBeLessThanOrEqual(448)
    expect(header.border[0]).toBeGreaterThan(240)
    expect(header.border[1]).toBeGreaterThan(240)
    expect(header.border[2]).toBeGreaterThan(240)
    expect(header.darkest).toBeLessThan(40)
  })
})

describe('digest EPUB QR images', () => {
  it('embeds one jpeg and one manifest item per article, and keeps them identical on the same day', async () => {
    const items = [
      item(CANDIDATE_A, '深い話', '<p>要約A</p><p><img src="https://example.com/photo.png" alt="写真"/></p>'),
      item(CANDIDATE_B, '関連', '<p>要約B</p>'),
    ]
    const qr = { publicOrigin: ORIGIN, secret: SECRET }
    const first = await buildDailyDigestWrite({ date: DATE, items, qr })
    const second = await buildDailyDigestWrite({ date: DATE, items, qr })
    const left = epubParts(first.write.epub)
    const right = unzipSync(second.write.epub)
    expect(left.jpgs).toEqual([
      `OEBPS/images/qr-${CANDIDATE_A}.jpg`,
      `OEBPS/images/qr-${CANDIDATE_B}.jpg`,
    ])
    expect(left.opf.match(/media-type="image\/jpeg"/g)).toHaveLength(2)
    expect(left.opf).not.toContain('image/png')
    expect(left.opf).toContain(`href="images/qr-${CANDIDATE_A}.jpg"`)
    expect(left.opf).toContain(`href="images/qr-${CANDIDATE_B}.jpg"`)
    expect(left.chapter).toContain(`<img class="digest-qr" src="images/qr-${CANDIDATE_A}.jpg" alt="全文を送る"/>`)
    expect(left.chapter).toContain(`<img class="digest-qr" src="images/qr-${CANDIDATE_B}.jpg" alt="全文を送る"/>`)
    expect(left.chapters).toHaveLength(2)
    expect(left.chapters[0]).toContain(`images/qr-${CANDIDATE_A}.jpg`)
    expect(left.chapters[0]).not.toContain(`images/qr-${CANDIDATE_B}.jpg`)
    expect(left.chapters[1]).toContain(`images/qr-${CANDIDATE_B}.jpg`)
    expect(left.chapters[1]).not.toContain(`images/qr-${CANDIDATE_A}.jpg`)
    expect(left.chapters[0]?.match(/class="digest-qr"/g)).toHaveLength(1)
    expect(left.chapters[1]?.match(/class="digest-qr"/g)).toHaveLength(1)
    expect(left.chapters[1]?.indexOf('要約B')).toBeLessThan(left.chapters[1]?.indexOf('class="digest-qr"') ?? -1)
    expect(left.chapters[1]).toContain(`id="send-${CANDIDATE_B}"`)
    expect(left.opf).toContain('<itemref idref="section-1"/>')
    expect(left.opf).toContain('<itemref idref="section-2"/>')
    expect(left.opf).not.toContain('href="chapter.xhtml"')
    expect(Object.keys(unzipSync(first.write.epub))).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/nav.xhtml',
      'OEBPS/section-1.xhtml',
      'OEBPS/section-2.xhtml',
      'OEBPS/style.css',
      `OEBPS/images/qr-${CANDIDATE_A}.jpg`,
      `OEBPS/images/qr-${CANDIDATE_B}.jpg`,
    ])
    expect(left.chapter).not.toContain('photo.png')
    expect(left.chapter).toContain('写真')
    expect(left.chapter).not.toContain(SECRET)
    const urlA = await confirmUrl(CANDIDATE_A)
    const files = unzipSync(first.write.epub)
    const jpeg = files[`OEBPS/images/qr-${CANDIDATE_A}.jpg`] ?? new Uint8Array()
    expect(Buffer.from(jpeg).equals(Buffer.from(qrJpeg(urlA)))).toBe(true)
    expect(Buffer.from(jpeg).equals(Buffer.from(right[`OEBPS/images/qr-${CANDIDATE_A}.jpg`] ?? new Uint8Array()))).toBe(
      true,
    )
    for (const name of left.jpgs) {
      const decoded = readQrJpeg(files[name] ?? new Uint8Array())
      expect(decoded.width).toBe(decoded.height)
      expect(decoded.border[0]).toBeGreaterThan(240)
      expect(decoded.darkest).toBeLessThan(40)
    }
  })

  it('keeps the second QR outside an unclosed summary table', async () => {
    const built = await buildDailyDigestWrite({
      date: DATE,
      items: [
        item(CANDIDATE_A, '深い話', '<p>要約A</p>'),
        item(CANDIDATE_B, '関連', '<table><tr><td>表'),
      ],
      qr: { publicOrigin: ORIGIN, secret: SECRET },
    })
    const second = epubParts(built.write.epub).chapters[1] ?? ''
    expect(second.match(/class="digest-qr"/g)).toHaveLength(1)
    expect(second).not.toMatch(/<td\b[^>]*>[\s\S]*class="digest-qr"/)
    expect(second).toContain(`images/qr-${CANDIDATE_B}.jpg`)
  })

  it('leaves a digest without a public origin image-free', async () => {
    const built = await buildDummyDailyWrite({ date: DATE, origin: mustUrl(ORIGIN) })
    const parts = epubParts(built.write.epub)
    expect(parts.jpgs).toEqual([])
    expect(parts.opf).not.toContain('image/jpeg')
    expect(parts.opf).not.toContain('image/png')
    expect(parts.chapter).not.toMatch(/<img\b/i)
  })
})

describe('digest confirm HTTP', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function harness(candidate: CandidateArticle) {
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const digestStore = createMemoryDigestStore()
    const queue = createFakeQueue()
    await candidateStore.put(candidate)
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
    return { store, candidateStore, digestStore, queue, app, env, logs }
  }

  it('does not call the queue on GET and enqueues only on POST', async () => {
    const canonicalUrl = mustUrl('https://example.com/send-me')
    const candidate = listed({
      id: asCandidateId(CANDIDATE_A),
      canonicalUrl,
      title: '送る記事',
    })
    const { queue, app, env, logs } = await harness(candidate)
    const url = await confirmUrl(CANDIDATE_A)
    const viewed = await app.request(url, { method: 'GET' }, env)
    expect(viewed.status).toBe(200)
    const html = await viewed.text()
    expect(html).toContain('全文を送る')
    expect(html).toContain('送る記事')
    expect(html).toContain('この画面を開いただけでは送信しません')
    expect(queue.size).toBe(0)
    const sent = await app.request(url, { method: 'POST' }, env)
    expect(sent.status).toBe(200)
    expect(await sent.text()).toContain('全文の準備を開始しました')
    expect(queue.size).toBe(1)
    expect(queue.peek()[0]?.url).toBe(canonicalUrl)
    const joined = logs.join('\n')
    const token = url.slice(url.lastIndexOf('/') + 1)
    expect(joined).not.toContain(token)
    expect(joined).not.toContain(SECRET)
  })

  it('rejects expired and tampered tokens without calling the queue', async () => {
    const candidate = listed({
      id: asCandidateId(CANDIDATE_A),
      canonicalUrl: mustUrl('https://example.com/send-me'),
      title: '送る記事',
    })
    const { queue, app, env } = await harness(candidate)
    const expiresAt = digestQrExpiresAt('2026-09-01')
    const token = await signDigestQrToken({ secret: SECRET, candidateId: CANDIDATE_A, expiresAt })
    const expiredUrl = digestConfirmUrl(ORIGIN, CANDIDATE_A, expiresAt, token)
    const expired = await app.request(expiredUrl, { method: 'POST' }, env)
    expect(expired.status).toBe(403)
    expect(await expired.text()).toContain('期限が切れています')
    expect(queue.size).toBe(0)
    const fresh = await confirmUrl(CANDIDATE_A)
    const tampered = `${fresh.slice(0, -1)}${fresh.endsWith('a') ? 'b' : 'a'}`
    const rejected = await app.request(tampered, { method: 'GET' }, env)
    expect(rejected.status).toBe(403)
    expect(await rejected.text()).toContain('この QR は使えません')
    expect(queue.size).toBe(0)
  })

  it('reuses a finished EPUB and does not create a run', async () => {
    const canonicalUrl = mustUrl('https://example.com/done')
    const candidate = listed({
      id: asCandidateId(CANDIDATE_A),
      canonicalUrl,
      title: '完成済み',
    })
    const { store, queue, app, env, candidateStore } = await harness(candidate)
    const articleId = await articleIdFromCanonicalUrl(canonicalUrl)
    await store.put({
      id: articleId,
      title: '完成済み',
      author: null,
      publishedAt: null,
      sourceUrl: canonicalUrl,
      canonicalUrl,
      language: 'ja',
      translated: false,
      epub: asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1])),
    })
    const url = await confirmUrl(CANDIDATE_A)
    const sent = await app.request(url, { method: 'POST' }, env)
    expect(sent.status).toBe(200)
    expect(await sent.text()).toContain('新しい生成は始めません')
    expect(queue.size).toBe(0)
    expect(await store.getJob(await clipJobIdFromUrl(canonicalUrl))).toBeNull()
    expect((await candidateStore.getById(candidate.id))?.clipRunId).toBeNull()
  })

  it('shows why a paywalled article cannot be sent and does not enqueue', async () => {
    const candidate = listed({
      id: asCandidateId(CANDIDATE_A),
      canonicalUrl: mustUrl('https://example.com/paid'),
      title: '有料記事',
      listingState: 'excluded',
      exclusionReason: 'paywalled',
    })
    const { queue, app, env } = await harness(candidate)
    const url = await confirmUrl(CANDIDATE_A)
    const viewed = await app.request(url, { method: 'GET' }, env)
    expect(viewed.status).toBe(200)
    const viewedHtml = await viewed.text()
    expect(viewedHtml).toContain('有料または除外されているため')
    expect(viewedHtml).not.toContain('<form')
    const sent = await app.request(url, { method: 'POST' }, env)
    expect(sent.status).toBe(200)
    expect(await sent.text()).toContain('有料または除外されているため')
    expect(queue.size).toBe(0)
  })

  it.each([
    ['unavailable', '全文を取得できないため送れません'],
    ['fetch_failed', 'ページを取得できなかったため送れません'],
  ] as const)('does not enqueue when full text is %s', async (reason, message) => {
    const candidate = listed({
      id: asCandidateId(CANDIDATE_A),
      canonicalUrl: mustUrl(`https://example.com/${reason}`),
      title: '送れない記事',
      ...(reason === 'fetch_failed'
        ? { fetchStatus: 'fetch_failed' as const }
        : { fullTextState: 'unavailable' as const }),
    })
    const { queue, app, env } = await harness(candidate)
    const sent = await app.request(await confirmUrl(CANDIDATE_A), { method: 'POST' }, env)
    expect(sent.status).toBe(200)
    expect(await sent.text()).toContain(message)
    expect(queue.size).toBe(0)
  })

  it('publishes a digest with QR images only when PUBLIC_ORIGIN is an origin', async () => {
    const store = createMemoryStore()
    const candidateStore = createMemoryCandidateStore()
    const digestStore = createMemoryDigestStore()
    const canonicalUrl = mustUrl('https://example.com/deep')
    await candidateStore.put(
      listed({
        id: asCandidateId(CANDIDATE_A),
        canonicalUrl,
        title: '深い話',
        recommendation: evaluatedRecommendation({
          grade: 'recommended',
          confidence: 0.94,
          model: 'test-model',
          excerptHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          evaluatedAt: NOW.toISOString(),
          relevant: true,
          concrete: true,
          verification: true,
          inputTokens: 20,
          durationMs: 10,
        }),
      }),
    )
    const summarize = async (candidate: CandidateArticle) =>
      ok({
        candidateId: candidate.id,
        canonicalUrl: candidate.canonicalUrl,
        title: candidate.title,
        summaryHtml: '<p>要約</p>',
      })
    const missing = await runDailyDigest(
      { ...TEST_BINDINGS, PUBLIC_ORIGIN: 'https://read.example.com/opds' } as Cloudflare.Env,
      {
        date: DATE,
        store,
        candidateStore,
        digestStore,
        fetchPage: async () => {
          throw new Error('unused')
        },
        summarize,
        now: () => NOW,
      },
    )
    expect(missing.qrCount).toBe(0)
    const missingEpub = epubParts((await store.getEpub(missing.articleId!)) ?? new Uint8Array())
    expect(missingEpub.jpgs).toEqual([])

    const published = await runDailyDigest({ ...TEST_BINDINGS, PUBLIC_ORIGIN: ORIGIN, CLIP_TOKEN: SECRET } as Cloudflare.Env, {
      date: DATE,
      store,
      candidateStore,
      digestStore,
      fetchPage: async () => {
        throw new Error('unused')
      },
      summarize,
      now: () => NOW,
    })
    expect(published.qrCount).toBe(1)
    const parts = epubParts((await store.getEpub(published.articleId!)) ?? new Uint8Array())
    expect(parts.jpgs).toHaveLength(1)
    expect(parts.opf.match(/media-type="image\/jpeg"/g)).toHaveLength(1)
    expect(parts.opf).toContain('href="chapter.xhtml"')
    expect(parts.opf).not.toContain('image/png')
  })
})
