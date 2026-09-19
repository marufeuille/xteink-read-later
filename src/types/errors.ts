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

export type NotFoundError = {
  readonly kind: 'not_found'
}

export type FetchError = PayloadTooLargeError | FetchFailedError

export type ExtractError = InvalidUrlError | FetchError | ExtractFailedError

export type PipelineError = ExtractError | TranslateFailedError

export type HttpErrorStatus = 400 | 401 | 404 | 413 | 422 | 502 | 503

export const httpStatusByErrorKind = {
  invalid_url: 400,
  unauthorized: 401,
  not_found: 404,
  payload_too_large: 413,
  extract_failed: 422,
  fetch_failed: 502,
  translate_failed: 503,
} as const satisfies Record<
  PipelineError['kind'] | UnauthorizedError['kind'] | NotFoundError['kind'],
  HttpErrorStatus
>

export type ErrorKind = keyof typeof httpStatusByErrorKind

export type HttpStatusOf<K extends ErrorKind> = (typeof httpStatusByErrorKind)[K]
