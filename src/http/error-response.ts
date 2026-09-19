import type { ErrorBody, ExtractError } from '../types'
import { httpStatusByErrorKind } from '../types'

export function errorMessage(error: ExtractError): string {
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
  }
}

export function toErrorBody(error: ExtractError): ErrorBody {
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
  }
}

export function toErrorResponse(error: ExtractError): Response {
  const body = toErrorBody(error)
  return Response.json(body, { status: httpStatusByErrorKind[error.kind] })
}
