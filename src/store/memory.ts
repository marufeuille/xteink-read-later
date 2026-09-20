import type {
  ArticleId,
  ArticleMeta,
  ArticleStore,
  ArticleWrite,
  ClipJobId,
  ClipJobRecord,
  EpubBytes,
} from '../types'

function nowIso(): string {
  return new Date().toISOString()
}

export function createMemoryStore(): ArticleStore {
  const metas = new Map<ArticleId, ArticleMeta>()
  const epubs = new Map<ArticleId, EpubBytes>()
  const jobs = new Map<ClipJobId, ClipJobRecord>()

  return {
    async getMeta(id) {
      return metas.get(id) ?? null
    },
    async getEpub(id) {
      return epubs.get(id) ?? null
    },
    async put(article: ArticleWrite) {
      const existing = metas.get(article.id)
      const createdAt = existing?.createdAt ?? nowIso()
      const meta: ArticleMeta = {
        id: article.id,
        title: article.title,
        author: article.author,
        publishedAt: article.publishedAt,
        sourceUrl: article.sourceUrl,
        canonicalUrl: article.canonicalUrl,
        language: article.language,
        translated: article.translated,
        createdAt,
        updatedAt: nowIso(),
      }
      epubs.set(article.id, article.epub)
      metas.set(article.id, meta)
      return meta
    },
    async delete(id) {
      const existed = metas.has(id) || epubs.has(id)
      metas.delete(id)
      epubs.delete(id)
      return existed
    },
    async listMeta() {
      return [...metas.values()]
        .filter((meta) => epubs.has(meta.id))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    },
    async getJob(id) {
      return jobs.get(id) ?? null
    },
    async putJob(job: ClipJobRecord) {
      jobs.set(job.jobId, job)
    },
  }
}
