import {
  asFeedRunId,
  asFeedSourceId,
  isFeedRunId,
  isFeedSourceType,
  parseHttpUrl,
  type CreateFeedSourceStore,
  type FeedCollectionStatus,
  type FeedSource,
  type FeedSourceType,
  type HttpUrl,
} from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCollectionStatus(value: unknown): value is FeedCollectionStatus {
  return value === 'queued' || value === 'running' || value === 'ready' || value === 'failed'
}

function parseTopicTags(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
  } catch {
    return []
  }
}

type SourceRow = {
  readonly id: string
  readonly name: string
  readonly site_url: string
  readonly feed_url: string
  readonly source_type: string
  readonly topic_tags: string
  readonly enabled: number
  readonly collection_run_id: string | null
  readonly collection_status: string | null
  readonly collection_attempt: number
  readonly collection_error_code: string | null
  readonly collection_error_message: string | null
  readonly items_seen: number
  readonly items_registered: number
  readonly items_duplicate: number
  readonly items_skipped: number
  readonly last_collected_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

function parseSource(row: unknown): FeedSource | null {
  if (!isRecord(row)) {
    return null
  }
  if (typeof row.id !== 'string' || !row.id.startsWith('src_')) {
    return null
  }
  const siteUrl = typeof row.site_url === 'string' ? parseHttpUrl(row.site_url) : null
  const feedUrl = typeof row.feed_url === 'string' ? parseHttpUrl(row.feed_url) : null
  if (siteUrl === null || feedUrl === null) {
    return null
  }
  if (typeof row.name !== 'string' || typeof row.source_type !== 'string' || !isFeedSourceType(row.source_type)) {
    return null
  }
  const enabledRaw = row.enabled
  const enabled = enabledRaw === 1 || enabledRaw === true
  if (enabledRaw !== 0 && enabledRaw !== 1 && enabledRaw !== false && enabledRaw !== true) {
    return null
  }
  if (typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') {
    return null
  }
  const collectionRunId =
    typeof row.collection_run_id === 'string' && isFeedRunId(row.collection_run_id)
      ? asFeedRunId(row.collection_run_id)
      : null
  const collectionStatus = isCollectionStatus(row.collection_status) ? row.collection_status : null
  const sourceType: FeedSourceType = row.source_type
  return {
    id: asFeedSourceId(row.id),
    name: row.name,
    siteUrl,
    feedUrl,
    sourceType,
    topicTags: typeof row.topic_tags === 'string' ? parseTopicTags(row.topic_tags) : [],
    enabled,
    collectionRunId,
    collectionStatus,
    collectionAttempt: typeof row.collection_attempt === 'number' ? row.collection_attempt : Number(row.collection_attempt ?? 0),
    collectionErrorCode: typeof row.collection_error_code === 'string' ? row.collection_error_code : null,
    collectionErrorMessage: typeof row.collection_error_message === 'string' ? row.collection_error_message : null,
    itemsSeen: typeof row.items_seen === 'number' ? row.items_seen : Number(row.items_seen ?? 0),
    itemsRegistered: typeof row.items_registered === 'number' ? row.items_registered : Number(row.items_registered ?? 0),
    itemsDuplicate: typeof row.items_duplicate === 'number' ? row.items_duplicate : Number(row.items_duplicate ?? 0),
    itemsSkipped: typeof row.items_skipped === 'number' ? row.items_skipped : Number(row.items_skipped ?? 0),
    lastCollectedAt: typeof row.last_collected_at === 'string' ? row.last_collected_at : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const createD1FeedSourceStore: CreateFeedSourceStore = (deps) => {
  const db = deps.CANDIDATES
  return {
    async getById(id) {
      const row = await db.prepare('SELECT * FROM feed_sources WHERE id = ?').bind(id).first<SourceRow>()
      return parseSource(row)
    },
    async getByFeedUrl(feedUrl: HttpUrl) {
      const row = await db
        .prepare('SELECT * FROM feed_sources WHERE feed_url = ?')
        .bind(feedUrl)
        .first<SourceRow>()
      return parseSource(row)
    },
    async put(source) {
      await db
        .prepare(
          `INSERT INTO feed_sources (
            id, name, site_url, feed_url, source_type, topic_tags, enabled,
            collection_run_id, collection_status, collection_attempt,
            collection_error_code, collection_error_message,
            items_seen, items_registered, items_duplicate, items_skipped,
            last_collected_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            site_url = excluded.site_url,
            feed_url = excluded.feed_url,
            source_type = excluded.source_type,
            topic_tags = excluded.topic_tags,
            enabled = excluded.enabled,
            collection_run_id = excluded.collection_run_id,
            collection_status = excluded.collection_status,
            collection_attempt = excluded.collection_attempt,
            collection_error_code = excluded.collection_error_code,
            collection_error_message = excluded.collection_error_message,
            items_seen = excluded.items_seen,
            items_registered = excluded.items_registered,
            items_duplicate = excluded.items_duplicate,
            items_skipped = excluded.items_skipped,
            last_collected_at = excluded.last_collected_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
        )
        .bind(
          source.id,
          source.name,
          source.siteUrl,
          source.feedUrl,
          source.sourceType,
          JSON.stringify(source.topicTags),
          source.enabled ? 1 : 0,
          source.collectionRunId,
          source.collectionStatus,
          source.collectionAttempt,
          source.collectionErrorCode,
          source.collectionErrorMessage,
          source.itemsSeen,
          source.itemsRegistered,
          source.itemsDuplicate,
          source.itemsSkipped,
          source.lastCollectedAt,
          source.createdAt,
          source.updatedAt,
        )
        .run()
    },
    async list() {
      const result = await db
        .prepare('SELECT * FROM feed_sources ORDER BY created_at DESC, id DESC')
        .all<SourceRow>()
      return result.results.map(parseSource).filter((row): row is FeedSource => row !== null)
    },
    async listEnabled() {
      const result = await db
        .prepare('SELECT * FROM feed_sources WHERE enabled = 1 ORDER BY created_at DESC, id DESC')
        .all<SourceRow>()
      return result.results.map(parseSource).filter((row): row is FeedSource => row !== null)
    },
  }
}
