import type { ExtractedArticle } from './article'
import type { HttpUrl } from './id'

export type InvalidUrlError = {
  readonly kind: 'invalid_url'
  readonly url: string
}

export type UnauthorizedError = {
  readonly kind: 'unauthorized'
}

export type PayloadTooLargeError = {
  readonly kind: 'payload_too_large'
  readonly bytes: number
}

export type FetchFailedError = {
  readonly kind: 'fetch_failed'
  readonly url: HttpUrl
  readonly reason: string
  // Site recovery determined that retrying the same URL will not succeed.
  readonly terminal?: true
}

export type ExtractFailedError = {
  readonly kind: 'extract_failed'
  readonly url: HttpUrl
  readonly reason: string
}

export type TranslateFailedError = {
  readonly kind: 'translate_failed'
  readonly extracted: ExtractedArticle
  readonly reason: string
}

export type EpubFailedError = {
  readonly kind: 'epub_failed'
  readonly url: HttpUrl
  readonly reason: string
}

export type NotFoundError = {
  readonly kind: 'not_found'
}

export type InvalidEpubError = {
  readonly kind: 'invalid_epub'
  readonly reason: string
}

export type QueueFailedError = {
  readonly kind: 'queue_failed'
  readonly reason: string
}

export type InternalError = {
  readonly kind: 'internal_error'
  readonly reason: string
}

export type CsrfFailedError = {
  readonly kind: 'csrf_failed'
}

export type InvalidFeedError = {
  readonly kind: 'invalid_feed'
  readonly reason: string
  readonly url: string
}

export type SourceDisabledError = {
  readonly kind: 'source_disabled'
}

export type CandidateUnsendableError = {
  readonly kind: 'candidate_unsendable'
  readonly reason: 'paywalled' | 'unavailable' | 'fetch_failed' | 'excluded'
}

export type FetchError = PayloadTooLargeError | FetchFailedError

export type ExtractError = InvalidUrlError | FetchError | ExtractFailedError

export type PipelineError = ExtractError | TranslateFailedError | EpubFailedError

export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503

export const httpStatusByErrorKind = {
  invalid_url: 400,
  invalid_epub: 400,
  invalid_feed: 400,
  unauthorized: 401,
  csrf_failed: 403,
  not_found: 404,
  source_disabled: 409,
  candidate_unsendable: 409,
  payload_too_large: 413,
  extract_failed: 422,
  epub_failed: 500,
  internal_error: 500,
  fetch_failed: 502,
  translate_failed: 503,
  queue_failed: 503,
} as const satisfies Record<
  | PipelineError['kind']
  | UnauthorizedError['kind']
  | CsrfFailedError['kind']
  | InvalidFeedError['kind']
  | SourceDisabledError['kind']
  | CandidateUnsendableError['kind']
  | NotFoundError['kind']
  | InvalidEpubError['kind']
  | QueueFailedError['kind']
  | InternalError['kind'],
  HttpErrorStatus
>

export type ErrorKind = keyof typeof httpStatusByErrorKind

export type HttpStatusOf<K extends ErrorKind> = (typeof httpStatusByErrorKind)[K]
