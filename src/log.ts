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
  'label',
  'action',
  'outcome',
  'pingState',
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

export type CronitorLogOutcome =
  | 'missing_api_key'
  | 'missing_monitor_key'
  | 'blank_api_key'
  | 'blank_monitor_key'
  | 'api_key_not_string'
  | 'monitor_key_not_string'
  | 'invalid_ping'
  | 'redirect_blocked'
  | 'sent'
  | 'http_error'
  | 'timeout'
  | 'network'
  | 'metrics_failed'

export type CronitorLog = {
  readonly event: 'cronitor'
  readonly outcome: CronitorLogOutcome
  readonly pingState?: 'run' | 'complete' | 'fail'
  readonly httpStatus?: number
  // ipv4 when the socket path was selected. Absent for an injected fetch.
  readonly transport?: 'ipv4'
  // Fixed token. Absent on success. Never an exception message, URL, or address.
  readonly cause?: 'dns' | 'connect' | 'http' | 'sockets'
}

export function logCronitor(entry: Omit<CronitorLog, 'event'>): void {
  writeStructuredLog({
    event: 'cronitor',
    outcome: entry.outcome,
    ...(entry.pingState === undefined ? {} : { pingState: entry.pingState }),
    ...(entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus }),
    ...(entry.transport === undefined ? {} : { transport: entry.transport }),
    ...(entry.cause === undefined ? {} : { cause: entry.cause }),
  } satisfies CronitorLog)
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
  // Hostname is indexed only on a terminal clip failure, and only after the same host check as feed logs.
  const { hostname: rawHostname, ...fields } = entry
  const hostname = entry.clipOutcome === 'failed' ? indexedLogHostname(rawHostname) : undefined
  writeStructuredLog({
    event: 'pipeline',
    ...pipelineLogFields(ctx),
    ...fields,
    ...(hostname === undefined ? {} : { hostname }),
  })
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

export type DigestInterestResult = 'recorded' | 'already_recorded' | 'ignored'

export type DigestInterestReason = 'not_in_issue' | 'invalid_expiry'

/** Weak positive only. Ordinary-or-below is the absence of a row, not a log line. */
export type DigestInterestLog = {
  readonly event: 'digest_interest'
  readonly result: DigestInterestResult
  readonly label?: 'weak_positive'
  readonly reason?: DigestInterestReason
  readonly issueDate?: string
  readonly candidateId: CandidateId
}

export function logDigestInterest(entry: Omit<DigestInterestLog, 'event'>): void {
  writeStructuredLog({
    event: 'digest_interest',
    result: entry.result,
    candidateId: entry.candidateId,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.issueDate === undefined ? {} : { issueDate: entry.issueDate }),
  } satisfies DigestInterestLog)
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
  /** HTTP status for fetch_failed. Absent when the fetch had no response status. */
  readonly statusCode?: number
  /**
   * Short fetch_failed token. Written to Workers Logs as `reason`.
   * The input name stays off `reason` so a free-form fetch message cannot be passed through.
   */
  readonly logReason?: string
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

function indexedLogHostname(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  return feedIndexHostname(value)
}

export function feedLogHostname(feedUrl: string): string | undefined {
  try {
    if (typeof feedUrl !== 'string' || !URL.canParse(feedUrl)) {
      return undefined
    }
    return feedIndexHostname(new URL(feedUrl).hostname)
  } catch {
    return undefined
  }
}

/** Article URL hostname for a terminal clip failure. Same indexed form as `feedLogHostname`. */
export function clipLogHostname(pageUrl: string): string | undefined {
  return feedLogHostname(pageUrl)
}

function finiteByteCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

// 1–48 chars. Letters, digits, and underscore. Rejects URLs, headers, and messages.
const FEED_FETCH_LOG_REASON = /^[A-Za-z][A-Za-z0-9_]{0,47}$/

function feedFetchStatusCode(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    return undefined
  }
  return value
}

function feedFetchLogReason(value: unknown): string | undefined {
  if (typeof value !== 'string' || !FEED_FETCH_LOG_REASON.test(value)) {
    return undefined
  }
  return value
}

export function feedCollectionErrorLog(error: {
  readonly kind: string
  readonly bytes?: unknown
  readonly statusCode?: unknown
  readonly logReason?: unknown
  // The stored fetch reason. Kept off the log: it may be an exception message or header.
  readonly reason?: unknown
}): {
  readonly errorKind: string
  readonly bytes?: number
  readonly statusCode?: number
  readonly logReason?: string
} {
  const bytes = error.kind === 'payload_too_large' ? finiteByteCount(error.bytes) : undefined
  const statusCode = error.kind === 'fetch_failed' ? feedFetchStatusCode(error.statusCode) : undefined
  const logReason = error.kind === 'fetch_failed' ? feedFetchLogReason(error.logReason) : undefined
  return {
    errorKind: error.kind,
    ...(bytes === undefined ? {} : { bytes }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(logReason === undefined ? {} : { logReason }),
  }
}

export function logFeed(entry: FeedLog): void {
  const failurePoint =
    entry.errorKind === 'internal_error' ? normalizeFeedFailurePoint(entry.failurePoint) : undefined
  const bytes = entry.errorKind === 'payload_too_large' ? finiteByteCount(entry.bytes) : undefined
  const statusCode = entry.errorKind === 'fetch_failed' ? feedFetchStatusCode(entry.statusCode) : undefined
  const reason = entry.errorKind === 'fetch_failed' ? feedFetchLogReason(entry.logReason) : undefined
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
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(reason === undefined ? {} : { reason }),
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

export type DailyDigestStage = 'start' | 'plan' | 'evaluate' | 'summarize' | 'publish' | 'watchdog'

/** `retry_exhausted` is the last queue attempt, including a prior exceededCpu kill. */
export type DailyDigestErrorKind = 'retry_exhausted' | 'internal_error'

export type DailyDigestLog = {
  readonly event: 'daily_digest'
  readonly date: string
  readonly status: 'published' | 'empty' | 'failed' | 'running'
  readonly stage?: DailyDigestStage
  readonly selected: number
  readonly summarized: number
  readonly skipped: number
  readonly durationMs: number
  readonly articleId?: string
  readonly qrCount: number
  readonly errorKind?: DailyDigestErrorKind
  readonly attempt?: number
}

export function logDailyDigest(entry: Omit<DailyDigestLog, 'event'>): void {
  const { articleId, stage, errorKind, attempt, ...rest } = entry
  writeStructuredLog({
    event: 'daily_digest',
    ...rest,
    ...(articleId === null || articleId === undefined ? {} : { articleId }),
    ...(stage === undefined ? {} : { stage }),
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(attempt === undefined ? {} : { attempt }),
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
