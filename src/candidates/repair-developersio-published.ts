import { extractCandidateMetadata } from './metadata'
import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import {
  DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS,
  isDevelopersIoCandidateUrl,
} from '../extract/published-at'
import { logPublishedRepair, logPublishedRepairFailure } from '../log'
import {
  asCandidateId,
  isCandidateId,
  parseHttpUrl,
  type CandidateId,
  type FetchPage,
  type HttpUrl,
} from '../types'

export const DEVELOPERS_IO_PUBLISHED_REPAIR_ID = 'developersio-published-at'

const REPAIR_FETCH_CONCURRENCY = 6

export type DevelopersIoRepairCandidate = {
  readonly id: CandidateId
  readonly canonicalUrl: HttpUrl
}

export type DevelopersIoPublishedRepairStore = {
  isComplete(): Promise<boolean>
  listPending(): Promise<readonly DevelopersIoRepairCandidate[]>
  writePublishedAt(id: CandidateId, publishedAt: string | null, completedAt: string): Promise<void>
  markComplete(completedAt: string): Promise<void>
}

export type DevelopersIoPublishedRepairDeps = {
  readonly store: DevelopersIoPublishedRepairStore
  readonly fetchPage?: FetchPage
  readonly now: () => Date
}

export type DevelopersIoPublishedRepairResult = {
  readonly examined: number
  readonly dated: number
  readonly cleared: number
  readonly alreadyComplete: boolean
}

type RepairCounts = {
  dated: number
  cleared: number
}

async function eachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return
  }
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) {
        return
      }
      const item = items[index]
      if (item === undefined) {
        return
      }
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

export async function repairDevelopersIoPublishedDates(
  deps: DevelopersIoPublishedRepairDeps,
): Promise<DevelopersIoPublishedRepairResult> {
  const started = Date.now()
  if (await deps.store.isComplete()) {
    return { examined: 0, dated: 0, cleared: 0, alreadyComplete: true }
  }

  const pending = await deps.store.listPending()
  const fetchPage = deps.fetchPage ?? defaultFetchPage
  const completedAt = deps.now().toISOString()
  const counts: RepairCounts = { dated: 0, cleared: 0 }

  await eachLimit(pending, REPAIR_FETCH_CONCURRENCY, async (candidate) => {
    let publishedAt: string | null = null
    try {
      const page = await fetchPage(candidate.canonicalUrl)
      if (page.ok) {
        publishedAt = extractCandidateMetadata(page.value).publishedAt
      }
    } catch {
      publishedAt = null
    }
    await deps.store.writePublishedAt(candidate.id, publishedAt, completedAt)
    if (publishedAt === null) {
      counts.cleared += 1
    } else {
      counts.dated += 1
    }
  })

  await deps.store.markComplete(completedAt)
  const result = {
    examined: pending.length,
    dated: counts.dated,
    cleared: counts.cleared,
    alreadyComplete: false,
  }
  logPublishedRepair({
    examined: result.examined,
    dated: result.dated,
    cleared: result.cleared,
    durationMs: Date.now() - started,
  })
  return result
}

let inflight: Promise<void> | null = null
let repairKnownComplete = false

export function startDevelopersIoPublishedRepair(env: Cloudflare.Env, fetchPage?: FetchPage): Promise<void> {
  if (repairKnownComplete) {
    return Promise.resolve()
  }
  if (inflight !== null) {
    return inflight
  }
  const started = Date.now()
  inflight = repairDevelopersIoPublishedDates({
    store: createD1DevelopersIoRepairStore(env.CANDIDATES),
    now: () => new Date(),
    ...(fetchPage === undefined ? {} : { fetchPage }),
  })
    .then(() => {
      repairKnownComplete = true
    })
    .catch(() => {
      logPublishedRepairFailure(Date.now() - started)
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function likePatterns(): readonly [string, string] {
  const httpsPattern = DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS[0]
  const httpPattern = DEVELOPERS_IO_CANONICAL_LIKE_PATTERNS[1]
  if (httpsPattern === undefined || httpPattern === undefined) {
    throw new Error('DevelopersIO canonical URL patterns are missing')
  }
  return [httpsPattern, httpPattern]
}

export function createD1DevelopersIoRepairStore(db: D1Database): DevelopersIoPublishedRepairStore {
  const [httpsPattern, httpPattern] = likePatterns()
  return {
    async isComplete() {
      const row = await db
        .prepare('SELECT id FROM data_repairs WHERE id = ?')
        .bind(DEVELOPERS_IO_PUBLISHED_REPAIR_ID)
        .first<{ id: string }>()
      return row !== null
    },
    async listPending() {
      const result = await db
        .prepare(
          `SELECT id, canonical_url FROM candidate_articles
           WHERE (canonical_url LIKE ? OR canonical_url LIKE ?)
             AND id NOT IN (SELECT candidate_id FROM candidate_published_repairs)
           ORDER BY id ASC`,
        )
        .bind(httpsPattern, httpPattern)
        .all<{ id: string; canonical_url: string }>()
      const pending: DevelopersIoRepairCandidate[] = []
      for (const row of result.results) {
        if (typeof row.id !== 'string' || !isCandidateId(row.id)) {
          continue
        }
        const canonicalUrl = typeof row.canonical_url === 'string' ? parseHttpUrl(row.canonical_url) : null
        if (canonicalUrl === null || !isDevelopersIoCandidateUrl(canonicalUrl)) {
          continue
        }
        pending.push({ id: asCandidateId(row.id), canonicalUrl })
      }
      return pending
    },
    async writePublishedAt(id, publishedAt, completedAt) {
      await db.batch([
        db.prepare('UPDATE candidate_articles SET published_at = ? WHERE id = ?').bind(publishedAt, id),
        db
          .prepare(
            `INSERT INTO candidate_published_repairs (candidate_id, completed_at) VALUES (?, ?)
             ON CONFLICT(candidate_id) DO UPDATE SET completed_at = excluded.completed_at`,
          )
          .bind(id, completedAt),
      ])
    },
    async markComplete(completedAt) {
      await db
        .prepare(
          `INSERT INTO data_repairs (id, completed_at) VALUES (?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(DEVELOPERS_IO_PUBLISHED_REPAIR_ID, completedAt)
        .run()
    },
  }
}
