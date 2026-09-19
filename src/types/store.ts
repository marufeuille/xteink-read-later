import type { ArticleMeta } from './article'
import type { ArticleId, EpubBytes } from './id'

export type StoreDeps = Pick<Cloudflare.Env, 'ARTICLES'>

export type StoredArticle = {
  readonly meta: ArticleMeta
  readonly epub: EpubBytes
}

export type ArticleWrite = Omit<ArticleMeta, 'createdAt' | 'updatedAt'> & {
  readonly epub: EpubBytes
}

export type ArticleStore = {
  readonly getMeta: (id: ArticleId) => Promise<ArticleMeta | null>
  readonly getEpub: (id: ArticleId) => Promise<EpubBytes | null>
  readonly put: (article: ArticleWrite) => Promise<ArticleMeta>
  readonly delete: (id: ArticleId) => Promise<boolean>
  readonly listMeta: () => Promise<readonly ArticleMeta[]>
}

export type CreateArticleStore = (deps: StoreDeps) => ArticleStore
