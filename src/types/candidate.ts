import type { ArticleId, CandidateDiscoveryId, CandidateId, ClipJobId, ClipRunId, FeedSourceId, HttpUrl } from './id'
import type { ClipJobError } from './job'
import type { CandidateRecommendation, CandidateRecommendPublic } from './recommend'

export const CANDIDATE_SOURCE_KIND_MANUAL_URL = 'manual_url' as const
export const CANDIDATE_SOURCE_KIND_FEED_PREFIX = 'feed:' as const

export type CandidateFeedSourceKind = `${typeof CANDIDATE_SOURCE_KIND_FEED_PREFIX}${FeedSourceId}`
export type CandidateSourceKind = typeof CANDIDATE_SOURCE_KIND_MANUAL_URL | CandidateFeedSourceKind

export function candidateFeedSourceKind(sourceId: FeedSourceId): CandidateFeedSourceKind {
  return `${CANDIDATE_SOURCE_KIND_FEED_PREFIX}${sourceId}`
}

export function isCandidateSourceKind(value: string): value is CandidateSourceKind {
  if (value === CANDIDATE_SOURCE_KIND_MANUAL_URL) {
    return true
  }
  return (
    value.startsWith(CANDIDATE_SOURCE_KIND_FEED_PREFIX) &&
    /^src_[a-f0-9]{32}$/.test(value.slice(CANDIDATE_SOURCE_KIND_FEED_PREFIX.length))
  )
}

export const CANDIDATE_FETCH_STATUSES = ['fetched', 'fetch_failed'] as const
export type CandidateFetchStatus = (typeof CANDIDATE_FETCH_STATUSES)[number]

export const CANDIDATE_LISTING_STATES = ['listed', 'excluded'] as const
export type CandidateListingState = (typeof CANDIDATE_LISTING_STATES)[number]

export const CANDIDATE_EXCLUSION_REASONS = ['paywalled'] as const
export type CandidateExclusionReason = (typeof CANDIDATE_EXCLUSION_REASONS)[number]

export const CANDIDATE_FULL_TEXT_STATES = ['confirmed_free', 'unconfirmed', 'unavailable'] as const
export type CandidateFullTextState = (typeof CANDIDATE_FULL_TEXT_STATES)[number]

export const CANDIDATE_DELIVERY_STATES = ['unsent', 'preparing', 'available', 'failed'] as const
export type CandidateDeliveryState = (typeof CANDIDATE_DELIVERY_STATES)[number]

export const CANDIDATE_UNSENDABLE_REASONS = ['paywalled', 'unavailable', 'fetch_failed', 'excluded'] as const
export type CandidateUnsendableReason = (typeof CANDIDATE_UNSENDABLE_REASONS)[number]

export const CANDIDATE_LIST_TIMEZONE = 'Asia/Tokyo'
export const CANDIDATE_LIST_PAGE_SIZE = 30
export const CANDIDATE_LIST_FILTER_MAX_LENGTH = 200
export const CANDIDATE_LIST_GRADE_FILTERS = ['recommended', 'related', 'low_priority', 'pending'] as const
export type CandidateListGradeFilter = (typeof CANDIDATE_LIST_GRADE_FILTERS)[number]

export function isCandidateListGradeFilter(value: string): value is CandidateListGradeFilter {
  return (CANDIDATE_LIST_GRADE_FILTERS as readonly string[]).includes(value)
}

export type CandidateListFilters = {
  readonly title: string
  readonly grade: CandidateListGradeFilter | ''
  readonly outlet: string
}

export const EMPTY_CANDIDATE_LIST_FILTERS: CandidateListFilters = {
  title: '',
  grade: '',
  outlet: '',
}

export type CandidateArticle = {
  readonly id: CandidateId
  readonly canonicalUrl: HttpUrl
  readonly sourceUrl: HttpUrl
  readonly title: string
  readonly outlet: string
  readonly publishedAt: string | null
  readonly discoveredAt: string
  readonly fetchStatus: CandidateFetchStatus
  readonly listingState: CandidateListingState
  readonly exclusionReason: CandidateExclusionReason | null
  readonly fullTextState: CandidateFullTextState
  readonly completedArticleId: ArticleId | null
  readonly clipJobId: ClipJobId | null
  readonly clipRunId: ClipRunId | null
  readonly selectedAt: string | null
  readonly recommendation: CandidateRecommendation
  readonly createdAt: string
  readonly updatedAt: string
}

export type CandidateDiscovery = {
  readonly id: CandidateDiscoveryId
  readonly candidateId: CandidateId
  readonly sourceKind: CandidateSourceKind
  readonly discoveredUrl: HttpUrl
  readonly discoveredAt: string
}

export type CandidateListQuery = {
  readonly limit: number
  readonly offset: number
} & Partial<CandidateListFilters>

export type CandidateListPage = {
  readonly items: readonly CandidateArticle[]
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly outlets: readonly string[]
}

export type CandidateStore = {
  readonly getById: (id: CandidateId) => Promise<CandidateArticle | null>
  readonly getByCanonicalUrl: (canonicalUrl: HttpUrl) => Promise<CandidateArticle | null>
  readonly getByClipJobId: (jobId: ClipJobId) => Promise<CandidateArticle | null>
  readonly put: (candidate: CandidateArticle) => Promise<void>
  readonly addDiscovery: (discovery: CandidateDiscovery) => Promise<boolean>
  readonly listDiscoveries: (candidateId: CandidateId) => Promise<readonly CandidateDiscovery[]>
  readonly listListed: (query: CandidateListQuery) => Promise<CandidateListPage>
}

export type CreateCandidateStore = (deps: Pick<Cloudflare.Env, 'CANDIDATES'>) => CandidateStore

export type CandidateNoticeKind =
  | 'registered'
  | 'duplicate'
  | 'paywalled'
  | 'fetch_failed'
  | 'clipped'
  | 'reused'
  | 'unsendable'
  | 'clip_failed'
  | 'rejudged'

export type CandidateNotice = {
  readonly kind: CandidateNoticeKind
  readonly message: string
}

export type CandidateRegisterResult = {
  readonly candidate: CandidateArticle
  readonly duplicate: boolean
  readonly notice: CandidateNotice
}

export type CandidatePublic = {
  readonly id: CandidateId
  readonly canonicalUrl: HttpUrl
  readonly sourceUrl: HttpUrl
  readonly title: string
  readonly outlet: string
  readonly publishedAt: string | null
  readonly discoveredAt: string
  readonly fetchStatus: CandidateFetchStatus
  readonly listingState: CandidateListingState
  readonly exclusionReason: CandidateExclusionReason | null
  readonly fullTextState: CandidateFullTextState
  readonly completedArticleId: ArticleId | null
  readonly clipJobId: ClipJobId | null
  readonly clipRunId: ClipRunId | null
  readonly selectedAt: string | null
  readonly deliveryState: CandidateDeliveryState
  readonly deliveryError: ClipJobError | null
  readonly availableInOpds: boolean
  readonly recommendation: CandidateRecommendPublic
}

export type CandidateRecommendBody = {
  readonly candidateId: CandidateId
  readonly reused: boolean
  readonly candidate: CandidatePublic
}

export type CandidateClipBody = {
  readonly candidateId: CandidateId
  readonly jobId: ClipJobId
  readonly runId: ClipRunId | null
  readonly status: 'queued' | 'ready' | 'failed'
  readonly reused: boolean
  readonly regenerated: boolean
  readonly deliveryState: CandidateDeliveryState
  readonly articleId: ArticleId | null
}

export type CandidateRegisterBody = {
  readonly id: CandidateId
  readonly duplicate: boolean
  readonly candidate: CandidatePublic
  readonly notice: CandidateNotice
}

export type CandidateListGroup = {
  readonly date: string | null
  readonly label: string
  readonly items: readonly CandidatePublic[]
}

export type CandidateListBody = {
  readonly timezone: typeof CANDIDATE_LIST_TIMEZONE
  readonly timezoneNote: string
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly groups: readonly CandidateListGroup[]
  readonly filters: CandidateListFilters
  readonly outlets: readonly string[]
}
