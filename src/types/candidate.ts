import type { ArticleId, CandidateDiscoveryId, CandidateId, HttpUrl } from './id'

export const CANDIDATE_SOURCE_KIND_MANUAL_URL = 'manual_url' as const

export type CandidateSourceKind = typeof CANDIDATE_SOURCE_KIND_MANUAL_URL

export const CANDIDATE_FETCH_STATUSES = ['fetched', 'fetch_failed'] as const
export type CandidateFetchStatus = (typeof CANDIDATE_FETCH_STATUSES)[number]

export const CANDIDATE_LISTING_STATES = ['listed', 'excluded'] as const
export type CandidateListingState = (typeof CANDIDATE_LISTING_STATES)[number]

export const CANDIDATE_EXCLUSION_REASONS = ['paywalled'] as const
export type CandidateExclusionReason = (typeof CANDIDATE_EXCLUSION_REASONS)[number]

export const CANDIDATE_FULL_TEXT_STATES = ['confirmed_free', 'unconfirmed', 'unavailable'] as const
export type CandidateFullTextState = (typeof CANDIDATE_FULL_TEXT_STATES)[number]

export const CANDIDATE_LIST_TIMEZONE = 'Asia/Tokyo'
export const CANDIDATE_LIST_PAGE_SIZE = 20

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
}

export type CandidateListPage = {
  readonly items: readonly CandidateArticle[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export type CandidateStore = {
  readonly getById: (id: CandidateId) => Promise<CandidateArticle | null>
  readonly getByCanonicalUrl: (canonicalUrl: HttpUrl) => Promise<CandidateArticle | null>
  readonly put: (candidate: CandidateArticle) => Promise<void>
  readonly addDiscovery: (discovery: CandidateDiscovery) => Promise<boolean>
  readonly listDiscoveries: (candidateId: CandidateId) => Promise<readonly CandidateDiscovery[]>
  readonly listListed: (query: CandidateListQuery) => Promise<CandidateListPage>
}

export type CreateCandidateStore = (deps: Pick<Cloudflare.Env, 'CANDIDATES'>) => CandidateStore

export type CandidateNoticeKind = 'registered' | 'duplicate' | 'paywalled' | 'fetch_failed'

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
}
