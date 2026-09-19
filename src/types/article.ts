import type { ArticleId, HttpUrl } from './id'

export type Language = 'ja' | 'non-ja'

export type ArticleFields = {
  readonly title: string
  readonly author: string | null
  readonly publishedAt: string | null
  readonly sourceUrl: HttpUrl
  readonly canonicalUrl: HttpUrl
}

export type ExtractedContent = ArticleFields & {
  readonly contentHtml: string
}

export type ExtractedArticle = ExtractedContent & {
  readonly language: Language
}

export type TranslatedArticle = ExtractedContent & {
  readonly language: 'ja'
  readonly translated: boolean
}

export type ArticleMeta = ArticleFields & {
  readonly id: ArticleId
  readonly language: 'ja'
  readonly translated: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export type FetchedPage = {
  readonly requestedUrl: HttpUrl
  readonly finalUrl: HttpUrl
  readonly contentType: string
  readonly html: string
}
