import type {
  ErrorBody,
  EpubFailedError,
  ExtractError,
  InvalidEpubError,
  InvalidFeedError,
  NotFoundError,
  PipelineError,
  QueueFailedError,
  SourceDisabledError,
  TranslateFailedBody,
  TranslateFailedError,
  UnauthorizedError,
  CsrfFailedError,
} from '../types'
import { httpStatusByErrorKind } from '../types'

export function errorMessage(
  error:
    | PipelineError
    | NotFoundError
    | UnauthorizedError
    | InvalidEpubError
    | InvalidFeedError
    | QueueFailedError
    | CsrfFailedError
    | SourceDisabledError,
): string {
  switch (error.kind) {
    case 'invalid_url':
      return error.url.length > 0
        ? `Invalid URL: ${error.url}`
        : 'Request body must be JSON with an http(s) url string'
    case 'invalid_epub':
      return error.reason
    case 'invalid_feed':
      return error.reason
    case 'payload_too_large':
      return `Payload exceeded the size limit (${error.bytes} bytes)`
    case 'fetch_failed':
      return `Failed to fetch ${error.url}: ${error.reason}`
    case 'extract_failed':
      return `Could not extract an article from ${error.url}: ${error.reason}`
    case 'epub_failed':
      return `Could not build an EPUB: ${error.reason}`
    case 'translate_failed':
      return `Translation failed: ${error.reason}`
    case 'queue_failed':
      return `Failed to enqueue job: ${error.reason}`
    case 'not_found':
      return 'Not found'
    case 'unauthorized':
      return 'Unauthorized'
    case 'csrf_failed':
      return 'CSRF token mismatch'
    case 'source_disabled':
      return 'Source is stopped'
  }
}

export function toErrorBody(
  error:
    | ExtractError
    | NotFoundError
    | EpubFailedError
    | InvalidEpubError
    | InvalidFeedError
    | QueueFailedError
    | CsrfFailedError
    | SourceDisabledError,
): ErrorBody {
  const message = errorMessage(error)
  switch (error.kind) {
    case 'invalid_url':
      return { error: { status: 400, code: 'invalid_url', message } }
    case 'invalid_epub':
      return { error: { status: 400, code: 'invalid_epub', message } }
    case 'invalid_feed':
      return { error: { status: 400, code: 'invalid_feed', message } }
    case 'payload_too_large':
      return { error: { status: 413, code: 'payload_too_large', message } }
    case 'fetch_failed':
      return { error: { status: 502, code: 'fetch_failed', message } }
    case 'extract_failed':
      return { error: { status: 422, code: 'extract_failed', message } }
    case 'epub_failed':
      return { error: { status: 500, code: 'epub_failed', message } }
    case 'queue_failed':
      return { error: { status: 503, code: 'queue_failed', message } }
    case 'not_found':
      return { error: { status: 404, code: 'not_found', message } }
    case 'csrf_failed':
      return { error: { status: 403, code: 'csrf_failed', message } }
    case 'source_disabled':
      return { error: { status: 409, code: 'source_disabled', message } }
  }
}

export function toTranslateFailedBody(error: TranslateFailedError): TranslateFailedBody {
  return {
    error: {
      status: 503,
      code: 'translate_failed',
      message: errorMessage(error),
      extracted: error.extracted,
    },
  }
}

export function toErrorResponse(
  error:
    | PipelineError
    | NotFoundError
    | InvalidEpubError
    | InvalidFeedError
    | QueueFailedError
    | CsrfFailedError
    | SourceDisabledError,
): Response {
  if (error.kind === 'translate_failed') {
    return Response.json(toTranslateFailedBody(error), { status: 503 })
  }
  const body = toErrorBody(error)
  return Response.json(body, { status: httpStatusByErrorKind[error.kind] })
}
