import { parseDailyDate } from './identity'
import {
  asArticleId,
  asCandidateId,
  isArticleId,
  isCandidateId,
  parseHttpUrl,
  type ArticleId,
  type CandidateId,
  type DigestPreparedItem,
  type HttpUrl,
} from '../types'

export const DIGEST_RUN_KEY_PREFIX = 'digest-runs/'

export type DigestRunPhase = 'plan' | 'evaluate' | 'summarize' | 'publish'

export type DigestRunStatus = 'running' | 'published' | 'empty' | 'failed'

export type DigestEvalRef = {
  readonly id: CandidateId
  readonly canonicalUrl: HttpUrl
  readonly discoveredAt: string
}

export type DigestRunRecord = {
  readonly v: 1
  readonly runId: string
  readonly date: string
  readonly status: DigestRunStatus
  readonly phase: DigestRunPhase
  readonly startedAt: string
  readonly updatedAt: string
  readonly planOffset: number
  readonly pendingEval: readonly DigestEvalRef[]
  readonly evalIndex: number
  readonly jevCalls: number
  readonly selectedIds: readonly CandidateId[]
  readonly summarizeIndex: number
  readonly prepared: readonly DigestPreparedItem[]
  readonly skipped: number
  readonly exhaustedSkips: number
  readonly articleId: ArticleId | null
  readonly qrCount: number
}

export type DigestRunLoaded = {
  readonly record: DigestRunRecord
  readonly etag: string
}

export type DigestRunPutResult = { readonly ok: true; readonly etag: string } | { readonly ok: false }

export type DigestRunStore = {
  readonly get: (date: string) => Promise<DigestRunLoaded | null>
  readonly put: (record: DigestRunRecord, expectedEtag: string | null) => Promise<DigestRunPutResult>
}

const RUN_ID_PATTERN = /^drun_[a-f0-9]{32}$/
const PHASES = ['plan', 'evaluate', 'summarize', 'publish'] as const
const STATUSES = ['running', 'published', 'empty', 'failed'] as const

export function digestRunKey(date: string): `digest-runs/${string}.json` {
  return `${DIGEST_RUN_KEY_PREFIX}${date}.json`
}

export function newDigestRunId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `drun_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function isDigestRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null
  }
  return value
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
    return null
  }
  return value
}

function parseEvalRef(value: unknown): DigestEvalRef | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isCandidateId(value.id)) {
    return null
  }
  if (typeof value.canonicalUrl !== 'string' || typeof value.discoveredAt !== 'string' || value.discoveredAt.length === 0) {
    return null
  }
  const canonicalUrl = parseHttpUrl(value.canonicalUrl)
  if (canonicalUrl === null) {
    return null
  }
  return { id: asCandidateId(value.id), canonicalUrl, discoveredAt: value.discoveredAt }
}

function parsePrepared(value: unknown): DigestPreparedItem | null {
  if (!isRecord(value) || typeof value.candidateId !== 'string' || !isCandidateId(value.candidateId)) {
    return null
  }
  if (typeof value.canonicalUrl !== 'string' || typeof value.title !== 'string' || typeof value.summaryHtml !== 'string') {
    return null
  }
  const canonicalUrl = parseHttpUrl(value.canonicalUrl)
  if (canonicalUrl === null || value.title.length === 0) {
    return null
  }
  return {
    candidateId: asCandidateId(value.candidateId),
    canonicalUrl,
    title: value.title,
    summaryHtml: value.summaryHtml,
  }
}

export function parseDigestRunRecord(value: unknown): DigestRunRecord | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.runId !== 'string' || !isDigestRunId(value.runId)) {
    return null
  }
  if (typeof value.date !== 'string' || parseDailyDate(value.date) !== value.date) {
    return null
  }
  if (typeof value.status !== 'string' || !(STATUSES as readonly string[]).includes(value.status)) {
    return null
  }
  if (typeof value.phase !== 'string' || !(PHASES as readonly string[]).includes(value.phase)) {
    return null
  }
  const startedAt = timestamp(value.startedAt)
  const updatedAt = timestamp(value.updatedAt)
  const planOffset = nonNegativeInt(value.planOffset)
  const evalIndex = nonNegativeInt(value.evalIndex)
  const jevCalls = nonNegativeInt(value.jevCalls)
  const summarizeIndex = nonNegativeInt(value.summarizeIndex)
  const skipped = nonNegativeInt(value.skipped)
  const exhaustedSkips = nonNegativeInt(value.exhaustedSkips)
  const qrCount = nonNegativeInt(value.qrCount)
  if (
    startedAt === null ||
    updatedAt === null ||
    planOffset === null ||
    evalIndex === null ||
    jevCalls === null ||
    summarizeIndex === null ||
    skipped === null ||
    exhaustedSkips === null ||
    qrCount === null
  ) {
    return null
  }
  if (!Array.isArray(value.pendingEval) || !Array.isArray(value.selectedIds) || !Array.isArray(value.prepared)) {
    return null
  }
  const pendingEval: DigestEvalRef[] = []
  for (const item of value.pendingEval) {
    const parsed = parseEvalRef(item)
    if (parsed === null) {
      return null
    }
    pendingEval.push(parsed)
  }
  const selectedIds: CandidateId[] = []
  for (const item of value.selectedIds) {
    if (typeof item !== 'string' || !isCandidateId(item)) {
      return null
    }
    selectedIds.push(asCandidateId(item))
  }
  const prepared: DigestPreparedItem[] = []
  for (const item of value.prepared) {
    const parsed = parsePrepared(item)
    if (parsed === null) {
      return null
    }
    prepared.push(parsed)
  }
  const articleId =
    value.articleId === null ? null : typeof value.articleId === 'string' && isArticleId(value.articleId) ? asArticleId(value.articleId) : undefined
  if (articleId === undefined) {
    return null
  }
  return {
    v: 1,
    runId: value.runId,
    date: value.date,
    status: value.status as DigestRunStatus,
    phase: value.phase as DigestRunPhase,
    startedAt,
    updatedAt,
    planOffset,
    pendingEval,
    evalIndex,
    jevCalls,
    summarizeIndex,
    prepared,
    skipped,
    exhaustedSkips,
    selectedIds,
    articleId,
    qrCount,
  }
}

function cloneRecord(record: DigestRunRecord): DigestRunRecord {
  return structuredClone(record)
}

export function createMemoryDigestRunStore(): DigestRunStore {
  const records = new Map<string, { readonly record: DigestRunRecord; etag: string }>()
  let version = 0

  return {
    async get(date) {
      const stored = records.get(date)
      if (stored === undefined) {
        return null
      }
      return { record: cloneRecord(stored.record), etag: stored.etag }
    },
    async put(record, expectedEtag) {
      const current = records.get(record.date)
      const currentEtag = current?.etag ?? null
      if (currentEtag !== expectedEtag) {
        return { ok: false }
      }
      version += 1
      const etag = `mem-${version}`
      records.set(record.date, { record: cloneRecord(record), etag })
      return { ok: true, etag }
    },
  }
}

export function createR2DigestRunStore(env: Pick<Cloudflare.Env, 'ARTICLES'>): DigestRunStore {
  const bucket = env.ARTICLES
  return {
    async get(date) {
      const object = await bucket.get(digestRunKey(date))
      if (object === null) {
        return null
      }
      let parsed: unknown
      try {
        parsed = await object.json()
      } catch {
        return null
      }
      const record = parseDigestRunRecord(parsed)
      if (record === null) {
        return null
      }
      return { record, etag: object.etag }
    },
    async put(record, expectedEtag) {
      const stored = await bucket.put(digestRunKey(record.date), JSON.stringify(record), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        onlyIf: expectedEtag === null ? { etagDoesNotMatch: '*' } : { etagMatches: expectedEtag },
      })
      if (stored === null) {
        return { ok: false }
      }
      return { ok: true, etag: stored.etag }
    },
  }
}
