import { articleMetaFromWrite, articleMetaWithClassification } from '../classify/parse'
import type {
  ArticleId,
  ArticleMeta,
  ArticleStore,
  ArticleWrite,
  ClipCheckpoint,
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
  const checkpoints = new Map<ClipJobId, ClipCheckpoint>()

  return {
    async getMeta(id) {
      return metas.get(id) ?? null
    },
    async getEpub(id) {
      return epubs.get(id) ?? null
    },
    async put(article: ArticleWrite) {
      const meta = articleMetaFromWrite(article, metas.get(article.id) ?? null, nowIso())
      epubs.set(article.id, article.epub)
      metas.set(article.id, meta)
      return meta
    },
    async putClassification(id, classification) {
      const existing = metas.get(id) ?? null
      if (existing === null) {
        return null
      }
      const meta = articleMetaWithClassification(existing, classification, nowIso())
      metas.set(id, meta)
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
    async getClipCheckpoint(id) {
      return checkpoints.get(id) ?? null
    },
    async putClipCheckpoint(checkpoint) {
      checkpoints.set(checkpoint.jobId, checkpoint)
    },
    async deleteClipCheckpoint(id) {
      checkpoints.delete(id)
    },
  }
}
