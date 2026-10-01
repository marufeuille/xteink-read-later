import { normalizeFeedFailurePoint, type FeedFailurePoint } from './feeds/failure-point'
import type { ArticleId, CandidateId, ClipJobId, ClipRunId, PipelineLog, PipelineLogContext } from './types'

export function pipelineLogFields(
  ctx: PipelineLogContext | undefined,
): Partial<PipelineLogContext> {
  if (ctx === undefined) {
    return {}
  }
  return {
    jobId: ctx.jobId,
    ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
    ...(ctx.attempt === undefined ? {} : { attempt: ctx.attempt }),
  }
}

// Workers Logs indexes fields when console.log receives an object. A JSON string stays one message.
function definedEntries(entry: object): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined) {
      fields[key] = value
    }
  }
  return fields
}

const SUMMARY_KEYS = [
  'stage',
  'clipOutcome',
  'status',
  'result',
  'action',
  'outcome',
  'errorKind',
  'failurePoint',
] as const

function summaryToken(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]+$/.test(value)) {
    return null
  }
  return value
}

function summaryMessage(fields: Record<string, unknown>): string {
  const parts = [summaryToken(fields.event) ?? 'log']
  for (const key of SUMMARY_KEYS) {
    const token = summaryToken(fields[key])
    if (token !== null) {
      parts.push(token)
    }
  }
  return parts.join(' ')
}

function writeStructuredLog(entry: object): void {
  const fields = definedEntries(entry)
  console.log({ message: summaryMessage(fields), ...fields })
}

export function logPipeline(entry: PipelineLog, ctx?: PipelineLogContext): void {
  if (ctx?.stages !== undefined) {
    ctx.stages.push({
      stage: entry.stage,
      durationMs: entry.durationMs,
      attempt: ctx.attempt ?? 0,
      ...(entry.errorKind === undefined ? {} : { errorKind: entry.errorKind }),
    })
  }
  writeStructuredLog({ event: 'pipeline', ...pipelineLogFields(ctx), ...entry })
}

export type SiteRecoveryLog = {
  readonly event: 'site_recovery'
  readonly site: string
  readonly outcome: 'recovered' | 'unavailable' | 'pass'
  readonly url: string
}

export function logSiteRecovery(entry: Omit<SiteRecoveryLog, 'event'>): void {
  writeStructuredLog({ event: 'site_recovery', ...entry } satisfies SiteRecoveryLog)
}

export type CandidateClipLog = {
  readonly event: 'candidate_clip'
  readonly action: 'select' | 'reuse' | 'regenerate'
  readonly candidateId: CandidateId
  readonly jobId: ClipJobId
  readonly runId?: ClipRunId
  readonly articleId?: ArticleId
  readonly selectedAt: string
  readonly discoveredAt: string
  readonly publishedAt: string | null
  readonly reused: boolean
  readonly regenerated: boolean
}

export type OpdsDownloadLog = {
  readonly event: 'opds_download'
  readonly articleId: ArticleId
  readonly durationMs: number
}

export function logCandidateClip(entry: Omit<CandidateClipLog, 'event'>): void {
  writeStructuredLog({ event: 'candidate_clip', ...entry } satisfies CandidateClipLog)
}

export function logOpdsDownload(entry: Omit<OpdsDownloadLog, 'event'>): void {
  writeStructuredLog({ event: 'opds_download', ...entry } satisfies OpdsDownloadLog)
}

export type DigestConfirmResult = 'view' | 'rejected' | 'unsendable' | 'reused' | 'queued' | 'failed'

export type DigestConfirmReason =
  | 'invalid'
  | 'expired'
  | 'not_found'
  | 'paywalled'
  | 'excluded'
  | 'unavailable'
  | 'fetch_failed'
  | 'queue_failed'

export type DigestConfirmLog = {
  readonly event: 'digest_confirm'
  readonly result: DigestConfirmResult
  readonly candidateId?: CandidateId
  readonly reason?: DigestConfirmReason
}

export function logDigestConfirm(entry: Omit<DigestConfirmLog, 'event'>): void {
  writeStructuredLog({ event: 'digest_confirm', ...entry } satisfies DigestConfirmLog)
}

export type CandidateRecommendLog = {
  readonly event: 'candidate_recommend'
  readonly candidateId: CandidateId
  readonly status: string
  readonly grade: string | null
  readonly version: string | null
  readonly durationMs: number
  readonly inputTokens: number | null
  readonly reused: boolean
  readonly errorCode: string | null
}

export function logCandidateRecommend(entry: Omit<CandidateRecommendLog, 'event'>): void {
  writeStructuredLog({ event: 'candidate_recommend', ...entry } satisfies CandidateRecommendLog)
}

export type { FeedFailurePoint }

export type FeedLog = {
  readonly stage: 'collect'
  readonly durationMs: number
  readonly errorKind?: string
  readonly failurePoint?: FeedFailurePoint
  readonly sourceId?: string
  /** Feed URL hostname. Scheme, userinfo, port, path, and query stay off the log. */
  readonly hostname?: string
  readonly runId?: string
  readonly attempt?: number
  /** Declared or received size. Number only, and only for payload_too_large. */
  readonly bytes?: number
}

const FEED_HOSTNAME =
  /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/
const FEED_IPV6_HOSTNAME = /^\[[0-9a-f:.]+\]$/

function feedIndexHostname(value: string): string | undefined {
  const hostname = value.toLowerCase().replace(/\.$/, '')
  if (hostname.length === 0 || hostname.length > 253) {
    return undefined
  }
  if (hostname.startsWith('[')) {
    return hostname.includes(':') && FEED_IPV6_HOSTNAME.test(hostname) ? hostname : undefined
  }
  return FEED_HOSTNAME.test(hostname) ? hostname : undefined
}

export function feedLogHostname(feedUrl: string): string | undefined {
  if (!URL.canParse(feedUrl)) {
    return undefined
  }
  return feedIndexHostname(new URL(feedUrl).hostname)
}

function finiteByteCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

export function feedCollectionErrorLog(error: {
  readonly kind: string
  readonly bytes?: unknown
}): { readonly errorKind: string; readonly bytes?: number } {
  const bytes = error.kind === 'payload_too_large' ? finiteByteCount(error.bytes) : undefined
  return {
    errorKind: error.kind,
    ...(bytes === undefined ? {} : { bytes }),
  }
}

export function logFeed(entry: FeedLog): void {
  const failurePoint =
    entry.errorKind === 'internal_error' ? normalizeFeedFailurePoint(entry.failurePoint) : undefined
  const bytes = entry.errorKind === 'payload_too_large' ? finiteByteCount(entry.bytes) : undefined
  const hostname = entry.hostname === undefined ? undefined : feedIndexHostname(entry.hostname)
  writeStructuredLog({
    event: 'feed',
    stage: entry.stage,
    durationMs: entry.durationMs,
    ...(entry.errorKind === undefined ? {} : { errorKind: entry.errorKind }),
    ...(failurePoint === undefined ? {} : { failurePoint }),
    ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
    ...(hostname === undefined ? {} : { hostname }),
    ...(entry.runId === undefined ? {} : { runId: entry.runId }),
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    ...(bytes === undefined ? {} : { bytes }),
  })
}

export type FeedScheduleLog = {
  readonly event: 'feed_schedule'
  readonly cron: string
  readonly queued: number
  readonly failed: number
  readonly durationMs: number
}

export function logFeedSchedule(entry: Omit<FeedScheduleLog, 'event'>): void {
  writeStructuredLog({ event: 'feed_schedule', ...entry } satisfies FeedScheduleLog)
}

export type DigestScheduleLog = {
  readonly event: 'digest_schedule'
  readonly cron: string
  readonly date: string
  readonly queued: number
  readonly failed: number
  readonly durationMs: number
}

export function logDigestSchedule(entry: Omit<DigestScheduleLog, 'event'>): void {
  writeStructuredLog({ event: 'digest_schedule', ...entry } satisfies DigestScheduleLog)
}

export type DailyDigestLog = {
  readonly event: 'daily_digest'
  readonly date: string
  readonly status: 'published' | 'empty' | 'failed'
  readonly selected: number
  readonly summarized: number
  readonly skipped: number
  readonly durationMs: number
  readonly articleId?: string
  readonly qrCount: number
}

export function logDailyDigest(entry: Omit<DailyDigestLog, 'event'>): void {
  const { articleId, ...rest } = entry
  writeStructuredLog({
    event: 'daily_digest',
    ...rest,
    ...(articleId === null || articleId === undefined ? {} : { articleId }),
  } satisfies DailyDigestLog)
}

export type PublishedRepairLog = {
  readonly event: 'published_repair'
  readonly examined: number
  readonly dated: number
  readonly cleared: number
  readonly durationMs: number
  readonly errorKind?: 'repair_failed'
}

export function logPublishedRepair(entry: Omit<PublishedRepairLog, 'event' | 'errorKind'>): void {
  writeStructuredLog({ event: 'published_repair', ...entry } satisfies PublishedRepairLog)
}

export function logPublishedRepairFailure(durationMs: number): void {
  writeStructuredLog({
    event: 'published_repair',
    examined: 0,
    dated: 0,
    cleared: 0,
    durationMs,
    errorKind: 'repair_failed',
  } satisfies PublishedRepairLog)
}
