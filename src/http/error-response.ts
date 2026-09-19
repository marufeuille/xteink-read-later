import type { ErrorBody, ExtractError, NotFoundError, PipelineError, TranslateFailedBody, TranslateFailedError } from '../types'
import { httpStatusByErrorKind } from '../types'

export function errorMessage(error: PipelineError | NotFoundError): string {
  switch (error.kind) {
    case 'invalid_url':
      return error.url.length > 0
        ? `Invalid URL: ${error.url}`
        : 'Request body must be JSON with an http(s) url string'
    case 'payload_too_large':
      return `Fetched HTML exceeded the size limit (${error.bytes} bytes)`
    case 'fetch_failed':
      return `Failed to fetch ${error.url}: ${error.reason}`
    case 'extract_failed':
      return `Could not extract an article from ${error.url}: ${error.reason}`
    case 'translate_failed':
      return `Translation failed: ${error.reason}`
    case 'not_found':
      return 'Article not found'
  }
}

export function toErrorBody(error: ExtractError | NotFoundError): ErrorBody {
  const message = errorMessage(error)
  switch (error.kind) {
    case 'invalid_url':
      return { error: { status: 400, code: 'invalid_url', message } }
    case 'payload_too_large':
      return { error: { status: 413, code: 'payload_too_large', message } }
    case 'fetch_failed':
      return { error: { status: 502, code: 'fetch_failed', message } }
    case 'extract_failed':
      return { error: { status: 422, code: 'extract_failed', message } }
    case 'not_found':
      return { error: { status: 404, code: 'not_found', message } }
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

export function toErrorResponse(error: PipelineError | NotFoundError): Response {
  if (error.kind === 'translate_failed') {
    return Response.json(toTranslateFailedBody(error), { status: 503 })
  }
  const body = toErrorBody(error)
  return Response.json(body, { status: httpStatusByErrorKind[error.kind] })
}
