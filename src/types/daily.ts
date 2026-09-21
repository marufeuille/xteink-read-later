import type { ArticleId, HttpUrl } from './id'
import type { ArticleMeta } from './article'

export const DAILY_TIMEZONE = 'Asia/Tokyo'
export const DAILY_CANONICAL_PREFIX = 'https://daily.invalid/digest/'
export const DAILY_IDENTITY_STRATEGY = 'new-id-per-jst-day'

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
