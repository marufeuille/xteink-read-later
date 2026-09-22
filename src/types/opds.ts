import type { ArticleMeta } from './article'
import type { ArticleId, EpubBytes, HttpUrl } from './id'

export type OpdsShelf = 'clip' | 'ebook'

export type OpdsFeedKind = 'navigation' | 'acquisition'

export type OpdsLocation =
  | { readonly kind: 'root' }
  | { readonly kind: 'shelf'; readonly shelf: OpdsShelf }
  | { readonly kind: 'date'; readonly shelf: OpdsShelf; readonly date: string }

export type OpdsCatalog = {
  readonly xml: string
  readonly feedKind: OpdsFeedKind
}

export type BuildOpdsCatalog = (
  articles: readonly ArticleMeta[],
  origin: HttpUrl,
  location: OpdsLocation,
) => OpdsCatalog | null

export type OpdsAcquisition = {
  readonly id: ArticleId
  readonly epub: EpubBytes
}
