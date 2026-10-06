import { sanitizeKind } from './message.ts'

const TIMEOUT_CODES = new Set<number | string>([
  23,
  'TIMEOUT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** Network, timeout, or an HTTP status. Not a missing secret or a malformed URL. */
export function isArticleReachabilityKind(errorKind: string): boolean {
  return errorKind === 'network' || errorKind === 'timeout' || /^http_\d{3}$/.test(errorKind)
}

/**
 * Classifies a thrown preflight fetch.
 * Timeout is by error name or code only. The message can contain the article URL, so it is ignored.
 */
export function preflightTransportErrorKind(error: unknown): 'network' | 'timeout' {
  return isTimeoutError(error, 0) ? 'timeout' : 'network'
}

/** Non-2xx preflight responses. Status outside 100–599 is reported as `network`. */
export function preflightStatusErrorKind(status: number): string {
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return `http_${status}`
  }
  return 'network'
}

/** Job summary for an article that did not respond. Names and values are not interpolated. */
export function articleUnreachableSummary(errorKind: string): string {
  const kind = sanitizeKind(errorKind)
  return `### deploy smoke\n\n記事に届きませんでした。failedStep=article-preflight errorKind=${kind}\n`
}

function isTimeoutError(error: unknown, depth: number): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) {
    return false
  }
  if ('name' in error && error.name === 'TimeoutError') {
    return true
  }
  if (
    'code' in error &&
    (typeof error.code === 'number' || typeof error.code === 'string') &&
    TIMEOUT_CODES.has(error.code)
  ) {
    return true
  }
  if ('cause' in error && error.cause !== error) {
    return isTimeoutError(error.cause, depth + 1)
  }
  return false
}
