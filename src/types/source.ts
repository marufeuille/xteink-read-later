import type { FetchError, InvalidFeedError } from './errors'
import type { FeedRunId, FeedSourceId, HttpUrl } from './id'
import type { Result } from './result'

export const FEED_SOURCE_TYPES = ['corporate_blog', 'posting_site', 'news', 'curation'] as const
export type FeedSourceType = (typeof FEED_SOURCE_TYPES)[number]

export const FEED_COLLECTION_STATUSES = ['queued', 'running', 'ready', 'failed'] as const
export type FeedCollectionStatus = (typeof FEED_COLLECTION_STATUSES)[number]

export const MAX_FEED_ITEMS = 20
export const MAX_FEED_PARSE_ITEMS = 50
export const MAX_FEED_BYTES = 1_000_000
export const COLLECT_TIME_BUDGET_MS = 20_000
export const FEED_COLLECTION_STALE_MS = 15 * 60 * 1000
export const MAX_FEED_TOPIC_TAGS = 8
export const MAX_FEED_TOPIC_TAG_LENGTH = 32

export type FetchedFeed = {
  readonly requestedUrl: HttpUrl
  readonly finalUrl: HttpUrl
  readonly contentType: string
  readonly xml: string
}

export type FetchFeed = (url: HttpUrl) => Promise<Result<FetchedFeed, FetchError>>

export type FeedItem = {
  readonly url: HttpUrl
  readonly title: string
  readonly publishedAt: string | null
}

export type ParsedFeed = {
  readonly format: 'rss' | 'atom'
  readonly title: string
  readonly siteUrl: HttpUrl | null
  readonly items: readonly FeedItem[]
}

export type FeedSource = {
  readonly id: FeedSourceId
  readonly name: string
  readonly siteUrl: HttpUrl
  readonly feedUrl: HttpUrl
  readonly sourceType: FeedSourceType
  readonly topicTags: readonly string[]
  readonly enabled: boolean
  readonly collectionRunId: FeedRunId | null
  readonly collectionStatus: FeedCollectionStatus | null
  readonly collectionAttempt: number
  readonly collectionErrorCode: string | null
  readonly collectionErrorMessage: string | null
  readonly itemsSeen: number
  readonly itemsRegistered: number
  readonly itemsDuplicate: number
  readonly itemsSkipped: number
  readonly lastCollectedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export type FeedSourceStore = {
  readonly getById: (id: FeedSourceId) => Promise<FeedSource | null>
  readonly getByFeedUrl: (feedUrl: HttpUrl) => Promise<FeedSource | null>
  readonly put: (source: FeedSource) => Promise<void>
  readonly list: () => Promise<readonly FeedSource[]>
  readonly listEnabled: () => Promise<readonly FeedSource[]>
}

export type CreateFeedSourceStore = (deps: Pick<Cloudflare.Env, 'CANDIDATES'>) => FeedSourceStore

export type FeedQueueMessage = {
  readonly sourceId: FeedSourceId
  readonly runId: FeedRunId
}

export type FeedCollectionCounts = {
  readonly itemsSeen: number
  readonly itemsRegistered: number
  readonly itemsDuplicate: number
  readonly itemsSkipped: number
}

export type FeedCollectionResult = FeedCollectionCounts & {
  readonly sourceId: FeedSourceId
  readonly runId: FeedRunId
  readonly status: 'ready' | 'failed'
  readonly error: InvalidFeedError | FetchError | null
}

export type FeedSourcePublic = {
  readonly id: FeedSourceId
  readonly name: string
  readonly siteUrl: HttpUrl
  readonly feedUrl: HttpUrl
  readonly sourceType: FeedSourceType
  readonly topicTags: readonly string[]
  readonly enabled: boolean
  readonly collectionStatus: FeedCollectionStatus | null
  readonly collectionErrorCode: string | null
  readonly collectionErrorMessage: string | null
  readonly itemsSeen: number
  readonly itemsRegistered: number
  readonly itemsDuplicate: number
  readonly itemsSkipped: number
  readonly lastCollectedAt: string | null
}

export type FeedSourceWriteBody = {
  readonly id: FeedSourceId
  readonly duplicate: boolean
  readonly source: FeedSourcePublic
}

export type FeedSourceListBody = {
  readonly sources: readonly FeedSourcePublic[]
}

export type FeedCollectBody = {
  readonly sourceId: FeedSourceId
  readonly runId: FeedRunId
  readonly status: 'queued'
}

export type FeedCollectAllBody = {
  readonly runs: readonly FeedCollectBody[]
  readonly failures: readonly { readonly sourceId: FeedSourceId; readonly error: string }[]
}

export function isFeedSourceType(value: string): value is FeedSourceType {
  return (FEED_SOURCE_TYPES as readonly string[]).includes(value)
}

export function toFeedSourcePublic(source: FeedSource): FeedSourcePublic {
  return {
    id: source.id,
    name: source.name,
    siteUrl: source.siteUrl,
    feedUrl: source.feedUrl,
    sourceType: source.sourceType,
    topicTags: source.topicTags,
    enabled: source.enabled,
    collectionStatus: source.collectionStatus,
    collectionErrorCode: source.collectionErrorCode,
    collectionErrorMessage: source.collectionErrorMessage,
    itemsSeen: source.itemsSeen,
    itemsRegistered: source.itemsRegistered,
    itemsDuplicate: source.itemsDuplicate,
    itemsSkipped: source.itemsSkipped,
    lastCollectedAt: source.lastCollectedAt,
  }
}
