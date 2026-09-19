import type { ArticleMeta } from './article'
import type { ArticleId, EpubBytes, HttpUrl } from './id'

export type OpdsCatalog = {
  readonly xml: string
}

export type BuildOpdsCatalog = (
  articles: readonly ArticleMeta[],
  origin: HttpUrl,
) => OpdsCatalog

export type OpdsAcquisition = {
  readonly id: ArticleId
  readonly epub: EpubBytes
}
