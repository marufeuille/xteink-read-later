import type { ArticleId, CandidateId, HttpUrl } from './id'
import type { ArticleMeta } from './article'

export const DAILY_TIMEZONE = 'Asia/Tokyo'
export const DAILY_CANONICAL_PREFIX = 'https://daily.invalid/digest/'
export const DAILY_IDENTITY_STRATEGY = 'new-id-per-jst-day'
/** UTC 19:00 = 04:00 Asia/Tokyo. Same expression as feed collection; one trigger runs both. Change this and wrangler.jsonc together. */
export const DAILY_DIGEST_CRON = '0 19 * * *'
export const DAILY_DIGEST_TIMEZONE = 'Asia/Tokyo'

export const DIGEST_BUCKETS = ['deep', 'tech', 'general'] as const
export type DigestBucket = (typeof DIGEST_BUCKETS)[number]

/** Upper bound for one bucket. There is no minimum and no backfill from another bucket. */
export type DigestBucketQuota = {
  readonly max: number
}

export const DIGEST_BUCKET_QUOTAS: Readonly<Record<DigestBucket, DigestBucketQuota>> = {
  deep: { max: 5 },
  tech: { max: 3 },
  general: { max: 2 },
}

/** Whole issue, not one article. A short issue is not stretched to fill the time. */
export const DIGEST_TARGET_READING_MINUTES = 5
/** E-ink reading pace used only to turn the issue target into a character budget. */
export const DIGEST_CHARS_PER_MINUTE = 400
/** Hard cap for one summary. One article never grows past this to fill five minutes. */
export const DIGEST_SUMMARY_MAX_CHARS = 400

export function digestSummaryCharBudget(articleCount: number): number {
  const count = Number.isInteger(articleCount) && articleCount > 0 ? articleCount : 1
  const issueBudget = DIGEST_TARGET_READING_MINUTES * DIGEST_CHARS_PER_MINUTE
  return Math.min(DIGEST_SUMMARY_MAX_CHARS, Math.floor(issueBudget / count))
}
/** Confirm links in a digest issue stay valid this many days from the issue date. */
export const DIGEST_QR_TTL_DAYS = 14
export const DIGEST_MAX_JEV_CALLS = 10
export const DIGEST_LIST_PAGE_SIZE = 100

export type DailyIssueIdentity = {
  readonly date: string
  readonly articleId: ArticleId
  readonly canonicalUrl: HttpUrl
  readonly opdsEntryId: string
  readonly acquisitionUrl: string
  readonly filename: `${ArticleId}.epub`
  readonly epubIdentifier: string
  readonly title: string
  readonly publishedAt: string
}

export type DailyIdentityComparison = {
  readonly left: DailyIssueIdentity
  readonly right: DailyIssueIdentity
  readonly sameArticleId: boolean
  readonly sameOpdsEntryId: boolean
  readonly sameAcquisitionUrl: boolean
  readonly sameFilename: boolean
  readonly sameEpubIdentifier: boolean
}

export type DailyPublishResult = {
  readonly meta: ArticleMeta
  readonly removedIds: readonly ArticleId[]
}

export type DigestQueueMessage = {
  readonly date: string
}

export type DailyDigestQueuedBody = {
  readonly date: string
  readonly status: 'queued'
}

export type DigestPublishedItem = {
  readonly date: string
  readonly candidateId: CandidateId
  readonly canonicalUrl: HttpUrl
  readonly title: string
}

export type DigestPreparedItem = {
  readonly candidateId: CandidateId
  readonly canonicalUrl: HttpUrl
  readonly title: string
  readonly summaryHtml: string
}

export type DigestSkipReason = 'paywalled' | 'fetch_failed' | 'title_only' | 'summarize_failed'

export type DigestRunStatus = 'published' | 'empty' | 'failed'

export type DigestRunResult = {
  readonly date: string
  readonly status: DigestRunStatus
  readonly selected: number
  readonly summarized: number
  readonly skipped: number
  readonly articleId: ArticleId | null
  readonly qrCount: number
}

export type DigestStore = {
  readonly listPublishedCanonicalUrlsExcept: (date: string) => Promise<ReadonlySet<string>>
  readonly replacePublishedItems: (date: string, items: readonly DigestPublishedItem[]) => Promise<void>
}

export type CreateDigestStore = (deps: Pick<Cloudflare.Env, 'CANDIDATES'>) => DigestStore
