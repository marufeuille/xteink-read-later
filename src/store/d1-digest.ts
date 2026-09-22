import type { CreateDigestStore } from '../types'

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
  }
}
