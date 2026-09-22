import { inflateSync, strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import {
  digestConfirmUrl,
  digestQrExpiresAt,
  signDigestQrToken,
  verifyDigestQrToken,
  workerPublicOrigin,
} from '../src/digest/confirm-link'
import { qrPng } from '../src/digest/qr-png'
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
import { createFakeQueue } from './fake-queue'

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

function epubParts(epub: Uint8Array): { readonly opf: string; readonly chapter: string; readonly pngs: string[] } {
  const files = unzipSync(epub)
  return {
    opf: strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array()),
    chapter: strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array()),
    pngs: Object.keys(files).filter((name) => name.endsWith('.png')).sort(),
  }
}

function pngHeader(png: Uint8Array): {
  readonly bitDepth: number
  readonly colorType: number
  readonly interlace: number
  readonly firstPixel: number[]
  readonly hasBlack: boolean
} {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  expect(new TextDecoder().decode(png.slice(12, 16))).toBe('IHDR')
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  let offset = 8
  const idat: Uint8Array[] = []
  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset)
    const type = new TextDecoder().decode(png.slice(offset + 4, offset + 8))
    const data = png.slice(offset + 8, offset + 8 + length)
    if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
    if (type === 'IEND') {
      break
    }
  }
  const compressed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0))
  let cursor = 0
  for (const part of idat) {
    compressed.set(part, cursor)
    cursor += part.length
  }
  const raw = inflateSync(compressed)
  const rowBytes = width * 3 + 1
  expect(raw.byteLength).toBe(rowBytes * height)
  expect(raw[0]).toBe(0)
  let hasBlack = false
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes
    for (let x = 0; x < width * 3; x += 1) {
      if (raw[row + 1 + x] === 0) {
        hasBlack = true
        break
      }
    }
  }
  return {
    bitDepth: png[24] ?? 0,
    colorType: png[25] ?? 0,
    interlace: png[28] ?? 1,
    firstPixel: [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0],
    hasBlack,
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

describe('digest QR png', () => {
  it('is a white non-interlaced RGB PNG and is deterministic', () => {
    const first = qrPng('https://read.example.com/digest/send/example')
    const second = qrPng('https://read.example.com/digest/send/example')
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const header = pngHeader(first)
    expect(header.bitDepth).toBe(8)
    expect(header.colorType).toBe(2)
    expect(header.interlace).toBe(0)
    expect(header.firstPixel).toEqual([255, 255, 255])
    expect(header.hasBlack).toBe(true)
  })
})

describe('digest EPUB QR images', () => {
  it('embeds one png and one manifest item per article, and keeps them identical on the same day', async () => {
    const items = [
      item(CANDIDATE_A, '深い話', '<p>要約A</p><p><img src="https://example.com/photo.png" alt="写真"/></p>'),
      item(CANDIDATE_B, '関連', '<p>要約B</p>'),
    ]
    const qr = { publicOrigin: ORIGIN, secret: SECRET }
    const first = await buildDailyDigestWrite({ date: DATE, items, qr })
    const second = await buildDailyDigestWrite({ date: DATE, items, qr })
    const left = epubParts(first.write.epub)
    const right = unzipSync(second.write.epub)
    expect(left.pngs).toEqual([
      `OEBPS/images/qr-${CANDIDATE_A}.png`,
      `OEBPS/images/qr-${CANDIDATE_B}.png`,
    ])
    expect(left.opf.match(/media-type="image\/png"/g)).toHaveLength(2)
    expect(left.opf).toContain(`href="images/qr-${CANDIDATE_A}.png"`)
    expect(left.opf).toContain(`href="images/qr-${CANDIDATE_B}.png"`)
    expect(left.chapter).toContain(`<img class="digest-qr" src="images/qr-${CANDIDATE_A}.png" alt="全文を送る"/>`)
    expect(left.chapter).toContain(`<img class="digest-qr" src="images/qr-${CANDIDATE_B}.png" alt="全文を送る"/>`)
    expect(left.chapter).not.toContain('photo.png')
    expect(left.chapter).toContain('写真')
    expect(left.chapter).not.toContain(SECRET)
    const urlA = await confirmUrl(CANDIDATE_A)
    const files = unzipSync(first.write.epub)
    const png = files[`OEBPS/images/qr-${CANDIDATE_A}.png`] ?? new Uint8Array()
    expect(Buffer.from(png).equals(Buffer.from(qrPng(urlA)))).toBe(true)
    expect(Buffer.from(png).equals(Buffer.from(right[`OEBPS/images/qr-${CANDIDATE_A}.png`] ?? new Uint8Array()))).toBe(
      true,
    )
  })

  it('leaves a digest without a public origin image-free', async () => {
    const built = await buildDummyDailyWrite({ date: DATE, origin: mustUrl(ORIGIN) })
    const parts = epubParts(built.write.epub)
    expect(parts.pngs).toEqual([])
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
    const queue = createFakeQueue()
    await candidateStore.put(candidate)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message))
    })
    const app = createApp({
      store,
      candidateStore,
      queue,
      now: () => NOW,
    })
    const env = { ...TEST_BINDINGS, CLIP_TOKEN: SECRET, PUBLIC_ORIGIN: ORIGIN, CLIP_QUEUE: queue } as Cloudflare.Env
    return { store, candidateStore, queue, app, env, logs }
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
    expect(missingEpub.pngs).toEqual([])

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
    expect(parts.pngs).toHaveLength(1)
    expect(parts.opf.match(/media-type="image\/png"/g)).toHaveLength(1)
  })
})
