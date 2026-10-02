import {
  isCandidateId,
  parseHttpUrl,
  type CreateDigestStore,
  type DigestInterestSnapshot,
  type DigestPublishedItem,
  type DigestQrFetchOutcome,
  type DigestQrFetchRecord,
} from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publishedItem(row: unknown): DigestPublishedItem | null {
  if (!isRecord(row)) {
    return null
  }
  if (
    typeof row.issue_date !== 'string' ||
    typeof row.candidate_id !== 'string' ||
    typeof row.canonical_url !== 'string' ||
    typeof row.title !== 'string' ||
    !isCandidateId(row.candidate_id)
  ) {
    return null
  }
  const canonicalUrl = parseHttpUrl(row.canonical_url)
  if (canonicalUrl === null) {
    return null
  }
  return {
    date: row.issue_date,
    candidateId: row.candidate_id,
    canonicalUrl,
    title: row.title,
  }
}

function fetchRecord(row: unknown): DigestQrFetchRecord | null {
  if (!isRecord(row)) {
    return null
  }
  if (
    typeof row.issue_date !== 'string' ||
    typeof row.candidate_id !== 'string' ||
    typeof row.fetched_at !== 'string' ||
    row.fetched_at.length === 0 ||
    !isCandidateId(row.candidate_id)
  ) {
    return null
  }
  return {
    issueDate: row.issue_date,
    candidateId: row.candidate_id,
    fetchedAt: row.fetched_at,
  }
}

export const createD1DigestStore: CreateDigestStore = (deps) => {
  const db = deps.CANDIDATES
  return {
    async listPublishedCanonicalUrlsExcept(date) {
      const result = await db
        .prepare('SELECT canonical_url FROM digest_published_items WHERE issue_date != ?')
        .bind(date)
        .all<{ canonical_url: string }>()
      const urls = new Set<string>()
      for (const row of result.results) {
        if (typeof row.canonical_url === 'string' && row.canonical_url.length > 0) {
          urls.add(row.canonical_url)
        }
      }
      return urls
    },
    async replacePublishedItems(date, items) {
      await db.batch([
        db.prepare('DELETE FROM digest_published_items WHERE issue_date = ?').bind(date),
        ...items.map((item) =>
          db
            .prepare(
              `INSERT INTO digest_published_items (issue_date, candidate_id, canonical_url, title)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(date, item.candidateId, item.canonicalUrl, item.title),
        ),
      ])
    },
    async recordPublishedQrFetch(input): Promise<DigestQrFetchOutcome> {
      const published = await db
        .prepare(
          `SELECT candidate_id FROM digest_published_items
           WHERE issue_date = ? AND candidate_id = ? LIMIT 1`,
        )
        .bind(input.issueDate, input.candidateId)
        .first()
      if (published === null) {
        return 'not_published'
      }
      const prior = await db
        .prepare(
          `SELECT fetched_at FROM digest_qr_interest
           WHERE issue_date = ? AND candidate_id = ?`,
        )
        .bind(input.issueDate, input.candidateId)
        .first<{ fetched_at: string }>()
      if (prior !== null && typeof prior.fetched_at === 'string') {
        return 'already_recorded'
      }
      await db
        .prepare(
          `INSERT OR IGNORE INTO digest_qr_interest (issue_date, candidate_id, fetched_at)
           VALUES (?, ?, ?)`,
        )
        .bind(input.issueDate, input.candidateId, input.fetchedAt)
        .run()
      const saved = await db
        .prepare(
          `SELECT fetched_at FROM digest_qr_interest
           WHERE issue_date = ? AND candidate_id = ?`,
        )
        .bind(input.issueDate, input.candidateId)
        .first<{ fetched_at: string }>()
      if (saved === null || saved.fetched_at !== input.fetchedAt) {
        return 'already_recorded'
      }
      return 'recorded'
    },
    async listInterestSnapshot(): Promise<DigestInterestSnapshot> {
      const [publishedRows, fetchRows] = await Promise.all([
        db
          .prepare(
            `SELECT issue_date, candidate_id, canonical_url, title
             FROM digest_published_items`,
          )
          .all(),
        db.prepare('SELECT issue_date, candidate_id, fetched_at FROM digest_qr_interest').all(),
      ])
      const published: DigestPublishedItem[] = []
      for (const row of publishedRows.results) {
        const item = publishedItem(row)
        if (item !== null) {
          published.push(item)
        }
      }
      const fetches: DigestQrFetchRecord[] = []
      for (const row of fetchRows.results) {
        const item = fetchRecord(row)
        if (item !== null) {
          fetches.push(item)
        }
      }
      return { published, fetches }
    },
  }
}
