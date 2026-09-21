import type { ArticleFields, ArticleMeta, ExtractedArticle, TranslatedArticle } from './article'
import type { CandidateListBody, CandidateRegisterBody } from './candidate'
import type { ClassifyErrorCode } from './classify'
import type { ErrorKind, HttpStatusOf, TranslateFailedError } from './errors'
import type { ArticleEpubKey, ArticleId, ClipJobId, EpubBytes, HttpUrl } from './id'
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

export type ClipTranslateTimingsMs = Pick<ClipTimingsMs, 'fetch' | 'extract' | 'translate'>

export type ClipExtractBody = ExtractedArticle & {
  readonly id: ArticleId
  readonly timingsMs: ClipExtractTimingsMs
}

export type ClipTranslatedBody = TranslatedArticle & {
  readonly id: ArticleId
  readonly timingsMs: ClipTranslateTimingsMs
}

export type ClipReadyBody = ArticleFields & {
  readonly id: ArticleId
  readonly language: TranslatedArticle['language']
  readonly translated: boolean
  readonly status: 'ready'
  readonly epubPath: `/${ArticleEpubKey}`
  readonly timingsMs: ClipTimingsMs
}

export type ClipQueuedBody = {
  readonly jobId: ClipJobId
  readonly status: 'queued'
  readonly sourceUrl: HttpUrl
}

export type ClipJobQueuedOrRunningBody = {
  readonly jobId: ClipJobId
  readonly status: 'queued' | 'running'
  readonly sourceUrl: HttpUrl
  readonly attempt: number
}

export type ClipJobReadyBody = {
  readonly jobId: ClipJobId
  readonly status: 'ready'
  readonly sourceUrl: HttpUrl
  readonly id: ArticleId
  readonly epubPath: `/${ArticleEpubKey}`
}

export type ClipJobFailedBody = {
  readonly jobId: ClipJobId
  readonly status: 'failed'
  readonly sourceUrl: HttpUrl
  readonly error: {
    readonly code: ErrorKind
    readonly message: string
  }
}

export type ClipJobBody = ClipJobQueuedOrRunningBody | ClipJobReadyBody | ClipJobFailedBody

export type ClipSuccessBody = ClipQueuedBody

export type PurchasedBookBody = ArticleFields & {
  readonly id: ArticleId
  readonly language: 'ja'
  readonly translated: false
  readonly status: 'ready'
  readonly epubPath: `/${ArticleEpubKey}`
}

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
  readonly clip: RouteSpec<'POST', '/clip', BearerAuth, ClipQueuedBody>
  readonly getClipJob: RouteSpec<'GET', '/clip/jobs/:jobId', BearerAuth, ClipJobBody>
  readonly getArticle: RouteSpec<'GET', '/articles/:id', BasicAuth, ArticleMeta>
  readonly getArticleEpub: RouteSpec<
    'GET',
    '/articles/:id/book.epub',
    BasicAuth,
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
  readonly postPurchasedBook: RouteSpec<'POST', '/books', BearerAuth, PurchasedBookBody>
  readonly postCandidate: RouteSpec<'POST', '/candidates', BearerAuth, CandidateRegisterBody>
  readonly listCandidates: RouteSpec<'GET', '/candidates.json', BearerAuth, CandidateListBody>
}

export const PIPELINE_STAGES = ['queue', 'fetch', 'extract', 'translate', 'epub', 'store', 'classify'] as const

export type PipelineStage = (typeof PIPELINE_STAGES)[number]

export type PipelineLog = {
  readonly articleId?: ArticleId
  readonly stage: PipelineStage
  readonly durationMs: number
  readonly errorKind?: ErrorKind | ClassifyErrorCode
}
