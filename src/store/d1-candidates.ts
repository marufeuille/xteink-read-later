import { compareListedByPublishedDate } from '../candidates/list'
import { listedFilterSql, parseCandidateListFilters } from '../candidates/list-filter'
import { parseCandidateRecommendation, recommendBindValues } from '../recommend/parse'
import {
  asArticleId,
  asCandidateDiscoveryId,
  asCandidateId,
  asClipJobId,
  asClipRunId,
  isArticleId,
  isClipJobId,
  isClipRunId,
  isCandidateSourceKind,
  parseHttpUrl,
  type CandidateArticle,
  type CandidateDiscovery,
  type CandidateExclusionReason,
  type CandidateFetchStatus,
  type CandidateFullTextState,
  type CandidateListingState,
  type CandidateSourceKind,
  type CandidateStore,
  type CreateCandidateStore,
  type HttpUrl,
} from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFetchStatus(value: unknown): value is CandidateFetchStatus {
  return value === 'fetched' || value === 'fetch_failed'
}

function isListingState(value: unknown): value is CandidateListingState {
  return value === 'listed' || value === 'excluded'
}

function isFullTextState(value: unknown): value is CandidateFullTextState {
  return value === 'confirmed_free' || value === 'unconfirmed' || value === 'unavailable'
}

function isExclusionReason(value: unknown): value is CandidateExclusionReason | null {
  return value === null || value === 'paywalled'
}

function isSourceKind(value: unknown): value is CandidateSourceKind {
  return typeof value === 'string' && isCandidateSourceKind(value)
}

type CandidateRow = {
  readonly id: string
  readonly canonical_url: string
  readonly source_url: string
  readonly title: string
  readonly outlet: string
  readonly published_at: string | null
  readonly discovered_at: string
  readonly fetch_status: string
  readonly listing_state: string
  readonly exclusion_reason: string | null
  readonly full_text_state: string
  readonly completed_article_id: string | null
  readonly clip_job_id: string | null
  readonly clip_run_id: string | null
  readonly selected_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

type DiscoveryRow = {
  readonly id: string
  readonly candidate_id: string
  readonly source_kind: string
  readonly discovered_url: string
  readonly discovered_at: string
}

function parseCandidate(row: unknown): CandidateArticle | null {
  if (!isRecord(row)) {
    return null
  }
  if (typeof row.id !== 'string' || !row.id.startsWith('cand_')) {
    return null
  }
  const canonicalUrl = typeof row.canonical_url === 'string' ? parseHttpUrl(row.canonical_url) : null
  const sourceUrl = typeof row.source_url === 'string' ? parseHttpUrl(row.source_url) : null
  if (canonicalUrl === null || sourceUrl === null) {
    return null
  }
  if (typeof row.title !== 'string' || typeof row.outlet !== 'string') {
    return null
  }
  if (!isFetchStatus(row.fetch_status) || !isListingState(row.listing_state) || !isFullTextState(row.full_text_state)) {
    return null
  }
  if (!isExclusionReason(row.exclusion_reason ?? null)) {
    return null
  }
  const exclusionReason = row.exclusion_reason === 'paywalled' ? 'paywalled' : null
  if (typeof row.discovered_at !== 'string' || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') {
    return null
  }
  const completed =
    typeof row.completed_article_id === 'string' && isArticleId(row.completed_article_id)
      ? asArticleId(row.completed_article_id)
      : null
  const clipJobId =
    typeof row.clip_job_id === 'string' && isClipJobId(row.clip_job_id) ? asClipJobId(row.clip_job_id) : null
  const clipRunId =
    typeof row.clip_run_id === 'string' && isClipRunId(row.clip_run_id) ? asClipRunId(row.clip_run_id) : null
  const selectedAt = typeof row.selected_at === 'string' ? row.selected_at : null
  const publishedAt = typeof row.published_at === 'string' ? row.published_at : null
  return {
    id: asCandidateId(row.id),
    canonicalUrl,
    sourceUrl,
    title: row.title,
    outlet: row.outlet,
    publishedAt,
    discoveredAt: row.discovered_at,
    fetchStatus: row.fetch_status,
    listingState: row.listing_state,
    exclusionReason,
    fullTextState: row.full_text_state,
    completedArticleId: completed,
    clipJobId,
    clipRunId,
    selectedAt,
    recommendation: parseCandidateRecommendation(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseDiscovery(row: unknown): CandidateDiscovery | null {
  if (!isRecord(row)) {
    return null
  }
  if (typeof row.id !== 'string' || typeof row.candidate_id !== 'string') {
    return null
  }
  if (!isSourceKind(row.source_kind)) {
    return null
  }
  const discoveredUrl = typeof row.discovered_url === 'string' ? parseHttpUrl(row.discovered_url) : null
  if (discoveredUrl === null || typeof row.discovered_at !== 'string') {
    return null
  }
  return {
    id: asCandidateDiscoveryId(row.id),
    candidateId: asCandidateId(row.candidate_id),
    sourceKind: row.source_kind,
    discoveredUrl,
    discoveredAt: row.discovered_at,
  }
}

export const createD1CandidateStore: CreateCandidateStore = (deps) => {
  const db = deps.CANDIDATES
  return {
    async getById(id) {
      const row = await db.prepare('SELECT * FROM candidate_articles WHERE id = ?').bind(id).first<CandidateRow>()
      return parseCandidate(row)
    },
    async getByCanonicalUrl(canonicalUrl: HttpUrl) {
      const row = await db
        .prepare('SELECT * FROM candidate_articles WHERE canonical_url = ?')
        .bind(canonicalUrl)
        .first<CandidateRow>()
      return parseCandidate(row)
    },
    async getByClipJobId(jobId) {
      const row = await db
        .prepare('SELECT * FROM candidate_articles WHERE clip_job_id = ? LIMIT 1')
        .bind(jobId)
        .first<CandidateRow>()
      return parseCandidate(row)
    },
    async put(candidate) {
      await db
        .prepare(
          `INSERT INTO candidate_articles (
            id, canonical_url, source_url, title, outlet, published_at, discovered_at,
            fetch_status, listing_state, exclusion_reason, full_text_state,
            completed_article_id, clip_job_id, clip_run_id, selected_at,
            recommend_status, recommend_grade, recommend_decided_grade, recommend_version,
            recommend_model, recommend_evaluated_at, recommend_excerpt_hash, recommend_confidence,
            recommend_relevant, recommend_concrete, recommend_verification, recommend_error_code,
            recommend_input_tokens, recommend_duration_ms, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            canonical_url = excluded.canonical_url,
            source_url = excluded.source_url,
            title = excluded.title,
            outlet = excluded.outlet,
            published_at = excluded.published_at,
            discovered_at = excluded.discovered_at,
            fetch_status = excluded.fetch_status,
            listing_state = excluded.listing_state,
            exclusion_reason = excluded.exclusion_reason,
            full_text_state = excluded.full_text_state,
            completed_article_id = excluded.completed_article_id,
            clip_job_id = excluded.clip_job_id,
            clip_run_id = excluded.clip_run_id,
            selected_at = excluded.selected_at,
            recommend_status = excluded.recommend_status,
            recommend_grade = excluded.recommend_grade,
            recommend_decided_grade = excluded.recommend_decided_grade,
            recommend_version = excluded.recommend_version,
            recommend_model = excluded.recommend_model,
            recommend_evaluated_at = excluded.recommend_evaluated_at,
            recommend_excerpt_hash = excluded.recommend_excerpt_hash,
            recommend_confidence = excluded.recommend_confidence,
            recommend_relevant = excluded.recommend_relevant,
            recommend_concrete = excluded.recommend_concrete,
            recommend_verification = excluded.recommend_verification,
            recommend_error_code = excluded.recommend_error_code,
            recommend_input_tokens = excluded.recommend_input_tokens,
            recommend_duration_ms = excluded.recommend_duration_ms,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
        )
        .bind(
          candidate.id,
          candidate.canonicalUrl,
          candidate.sourceUrl,
          candidate.title,
          candidate.outlet,
          candidate.publishedAt,
          candidate.discoveredAt,
          candidate.fetchStatus,
          candidate.listingState,
          candidate.exclusionReason,
          candidate.fullTextState,
          candidate.completedArticleId,
          candidate.clipJobId,
          candidate.clipRunId,
          candidate.selectedAt,
          ...recommendBindValues(candidate.recommendation),
          candidate.createdAt,
          candidate.updatedAt,
        )
        .run()
    },
    async addDiscovery(discovery) {
      try {
        await db
          .prepare(
            `INSERT INTO candidate_discoveries (
              id, candidate_id, source_kind, discovered_url, discovered_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            discovery.id,
            discovery.candidateId,
            discovery.sourceKind,
            discovery.discoveredUrl,
            discovery.discoveredAt,
          )
          .run()
        return true
      } catch {
        return false
      }
    },
    async listDiscoveries(candidateId) {
      const result = await db
        .prepare(
          'SELECT * FROM candidate_discoveries WHERE candidate_id = ? ORDER BY discovered_at ASC, id ASC',
        )
        .bind(candidateId)
        .all<DiscoveryRow>()
      return result.results.map(parseDiscovery).filter((row): row is CandidateDiscovery => row !== null)
    },
    async listListed(query) {
      const filters = parseCandidateListFilters(query)
      const { where, binds } = listedFilterSql(filters)
      const results = await db.batch([
        db.prepare(`SELECT COUNT(*) AS total FROM candidate_articles WHERE ${where}`).bind(...binds),
        db
          .prepare(
            `SELECT * FROM candidate_articles
             WHERE ${where}
             ORDER BY CASE WHEN datetime(published_at) IS NULL THEN 1 ELSE 0 END ASC,
               datetime(published_at) DESC,
               discovered_at DESC,
               id DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(...binds, query.limit, query.offset),
        db
          .prepare(
            `SELECT DISTINCT outlet FROM candidate_articles
             WHERE listing_state = ?
             ORDER BY outlet COLLATE NOCASE`,
          )
          .bind('listed'),
      ])
      const countRow = results[0]
      const list = results[1]
      const outletRows = results[2]
      if (countRow === undefined || list === undefined || outletRows === undefined) {
        return { items: [], total: 0, limit: query.limit, offset: query.offset, outlets: [] }
      }
      const totalRaw = (countRow.results[0] as { total?: unknown } | undefined)?.total
      const total = typeof totalRaw === 'number' ? totalRaw : Number(totalRaw ?? 0)
      const items = (list.results as CandidateRow[])
        .map(parseCandidate)
        .filter((row): row is CandidateArticle => row !== null)
        .sort(compareListedByPublishedDate)
      const outlets = outletRows.results
        .map((row) => (isRecord(row) && typeof row.outlet === 'string' ? row.outlet : null))
        .filter((row): row is string => row !== null && row !== '')
      return {
        items,
        total,
        limit: query.limit,
        offset: query.offset,
        outlets,
      }
    },
  }
}
