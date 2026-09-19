import type { ArticleFields, ArticleMeta, ExtractedArticle, TranslatedArticle } from './article'
import type { ErrorKind, HttpStatusOf, TranslateFailedError } from './errors'
import type { ArticleEpubKey, ArticleId, EpubBytes } from './id'
import type { OpdsCatalog } from './opds'

export type ClipRequestBody = {
  readonly url: string
}

export type ClipTimingsMs = {
  readonly fetch: number
  readonly extract: number
  readonly translate: number
  readonly epub: number
}

export type ClipExtractTimingsMs = Pick<ClipTimingsMs, 'fetch' | 'extract'>

export type ClipExtractBody = ExtractedArticle & {
  readonly id: ArticleId
  readonly timingsMs: ClipExtractTimingsMs
}

export type ClipReadyBody = ArticleFields & {
  readonly id: ArticleId
  readonly language: TranslatedArticle['language']
  readonly translated: boolean
  readonly status: 'ready'
  readonly epubPath: `/${ArticleEpubKey}`
  readonly timingsMs: ClipTimingsMs
}

export type ClipSuccessBody = ClipExtractBody | ClipReadyBody

export type ErrorBody = {
  [K in ErrorKind]: {
    readonly error: {
      readonly status: HttpStatusOf<K>
      readonly code: K
      readonly message: string
    }
  }
}[ErrorKind]

export type TranslateFailedBody = {
  readonly error: Extract<ErrorBody, { error: { code: TranslateFailedError['kind'] } }>['error'] & {
    readonly extracted: ExtractedArticle
  }
}

export type BearerAuth = {
  readonly scheme: 'bearer'
}

export type BasicAuth = {
  readonly scheme: 'basic'
}

export type RouteSpec<
  TMethod extends string,
  TPath extends string,
  TAuth,
  TSuccess,
> = {
  readonly method: TMethod
  readonly path: TPath
  readonly auth: TAuth
  readonly success: TSuccess
}

export type ApiRoutes = {
  readonly clip: RouteSpec<'POST', '/clip', BearerAuth, ClipSuccessBody>
  readonly getArticle: RouteSpec<'GET', '/articles/:id', null, ArticleMeta>
  readonly getArticleEpub: RouteSpec<
    'GET',
    '/articles/:id/book.epub',
    null,
    EpubBytes
  >
  readonly deleteArticle: RouteSpec<
    'DELETE',
    '/articles/:id',
    BearerAuth,
    { readonly deleted: true }
  >
  readonly opdsCatalog: RouteSpec<'GET', '/opds', BasicAuth, OpdsCatalog>
  readonly opdsDownload: RouteSpec<
    'GET',
    '/opds/download/:id.epub',
    BasicAuth,
    EpubBytes
  >
}

export type PipelineLog = {
  readonly articleId?: ArticleId
  readonly stage: keyof ClipTimingsMs | 'store'
  readonly durationMs: number
  readonly errorKind?: ErrorKind
}
