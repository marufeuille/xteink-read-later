import type { ArticleMeta, ArticleStore, ArticleWrite, EpubBytes, ArticleId } from '../types'

function nowIso(): string {
  return new Date().toISOString()
}

export function createMemoryStore(): ArticleStore {
  const metas = new Map<ArticleId, ArticleMeta>()
  const epubs = new Map<ArticleId, EpubBytes>()

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
      metas.set(article.id, meta)
      epubs.set(article.id, article.epub)
      return meta
    },
    async delete(id) {
      const existed = metas.delete(id)
      epubs.delete(id)
      return existed
    },
    async listMeta() {
      return [...metas.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    },
  }
}
