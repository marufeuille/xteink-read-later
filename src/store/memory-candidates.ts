import {
  candidateMatchesListFilters,
  parseCandidateListFilters,
  uniqueListedOutlets,
} from '../candidates/list-filter'
import type {
  CandidateArticle,
  CandidateDiscovery,
  CandidateListPage,
  CandidateListQuery,
  CandidateStore,
  ClipJobId,
  HttpUrl,
} from '../types'

function compareListed(a: CandidateArticle, b: CandidateArticle): number {
  const aUnknown = a.publishedAt === null ? 1 : 0
  const bUnknown = b.publishedAt === null ? 1 : 0
  if (aUnknown !== bUnknown) {
    return aUnknown - bUnknown
  }
  if (a.publishedAt !== null && b.publishedAt !== null && a.publishedAt !== b.publishedAt) {
    return a.publishedAt < b.publishedAt ? 1 : -1
  }
  if (a.discoveredAt !== b.discoveredAt) {
    return a.discoveredAt < b.discoveredAt ? 1 : -1
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export function createMemoryCandidateStore(): CandidateStore {
  const articles = new Map<string, CandidateArticle>()
  const discoveries = new Map<string, CandidateDiscovery[]>()

  return {
    async getById(id) {
      return articles.get(id) ?? null
    },
    async getByCanonicalUrl(canonicalUrl: HttpUrl) {
      for (const article of articles.values()) {
        if (article.canonicalUrl === canonicalUrl) {
          return article
        }
      }
      return null
    },
    async getByClipJobId(jobId: ClipJobId) {
      for (const article of articles.values()) {
        if (article.clipJobId === jobId) {
          return article
        }
      }
      return null
    },
    async put(candidate) {
      articles.set(candidate.id, candidate)
    },
    async addDiscovery(discovery) {
      const existing = discoveries.get(discovery.candidateId) ?? []
      if (
        existing.some(
          (row) =>
            row.sourceKind === discovery.sourceKind && row.discoveredUrl === discovery.discoveredUrl,
        )
      ) {
        return false
      }
      discoveries.set(discovery.candidateId, [...existing, discovery])
      return true
    },
    async listDiscoveries(candidateId) {
      return discoveries.get(candidateId) ?? []
    },
    async listListed(query: CandidateListQuery): Promise<CandidateListPage> {
      const all = [...articles.values()]
      const filters = parseCandidateListFilters(query)
      const matched = all.filter((article) => candidateMatchesListFilters(article, filters))
      matched.sort(compareListed)
      return {
        items: matched.slice(query.offset, query.offset + query.limit),
        total: matched.length,
        limit: query.limit,
        offset: query.offset,
        outlets: uniqueListedOutlets(all),
      }
    },
  }
}
