import type {
  DigestInterestSnapshot,
  DigestPublishedItem,
  DigestQrFetchOutcome,
  DigestQrFetchRecord,
  DigestStore,
} from '../types'

function interestKey(issueDate: string, candidateId: string): string {
  return `${issueDate}\0${candidateId}`
}

export function createMemoryDigestStore(): DigestStore {
  const byDate = new Map<string, DigestPublishedItem[]>()
  const fetches = new Map<string, DigestQrFetchRecord>()

  return {
    async listPublishedCanonicalUrlsExcept(date) {
      const urls = new Set<string>()
      for (const [issueDate, items] of byDate) {
        if (issueDate !== date) {
          for (const item of items) {
            urls.add(item.canonicalUrl)
          }
        }
      }
      return urls
    },
    async replacePublishedItems(date, items) {
      byDate.set(date, items.map((item) => ({ ...item })))
    },
    async recordPublishedQrFetch(input): Promise<DigestQrFetchOutcome> {
      const items = byDate.get(input.issueDate) ?? []
      if (!items.some((item) => item.candidateId === input.candidateId)) {
        return 'not_published'
      }
      const key = interestKey(input.issueDate, input.candidateId)
      const existing = fetches.get(key)
      if (existing !== undefined) {
        return 'already_recorded'
      }
      fetches.set(key, {
        issueDate: input.issueDate,
        candidateId: input.candidateId,
        fetchedAt: input.fetchedAt,
      })
      return 'recorded'
    },
    async listInterestSnapshot(): Promise<DigestInterestSnapshot> {
      const published: DigestPublishedItem[] = []
      for (const items of byDate.values()) {
        published.push(...items.map((item) => ({ ...item })))
      }
      return { published, fetches: [...fetches.values()] }
    },
  }
}
