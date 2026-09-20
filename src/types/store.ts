import type { ArticleMeta } from './article'
import type { ArticleId, ClipJobId, EpubBytes } from './id'
import type { ClipJobRecord, PipelineLogContext } from './job'

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
  readonly put: (article: ArticleWrite, log?: PipelineLogContext) => Promise<ArticleMeta>
  readonly delete: (id: ArticleId) => Promise<boolean>
  readonly listMeta: () => Promise<readonly ArticleMeta[]>
  readonly getJob: (id: ClipJobId) => Promise<ClipJobRecord | null>
  readonly putJob: (job: ClipJobRecord) => Promise<void>
}

export type CreateArticleStore = (deps: StoreDeps) => ArticleStore
