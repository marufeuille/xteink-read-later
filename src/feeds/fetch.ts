import { readBoundedBytes } from '../extract/bounded-body'
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../extract/constants'
import { decodeHtmlBytes } from '../extract/html-encoding'
import type { FetchError, FetchFailedError, FetchedFeed, FetchFeed, HttpUrl, Result } from '../types'
import { err, MAX_FEED_BYTES, ok, parseHttpUrl } from '../types'
import { isFeedContentType } from './parse'

// Same token rule as feedFetchLogReason in src/log.ts. The logger drops anything else.
const FEED_LOG_REASON = /^[A-Za-z][A-Za-z0-9_]{0,47}$/

function responseStatusCode(status: number): number | undefined {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return undefined
  }
  return status
}

function withStatus(status: number): { readonly statusCode?: number } {
  const statusCode = responseStatusCode(status)
  return statusCode === undefined ? {} : { statusCode }
}

function fetchFailed(
  url: HttpUrl,
  reason: string,
  detail: { readonly statusCode?: number; readonly logReason?: string },
): FetchFailedError {
  return {
    kind: 'fetch_failed',
    url,
    reason,
    ...(detail.statusCode === undefined ? {} : { statusCode: detail.statusCode }),
    ...(detail.logReason === undefined ? {} : { logReason: detail.logReason }),
  }
}

// This fetch aborts only through AbortSignal.timeout, so AbortError is a timeout.
function thrownLogReason(cause: unknown): string | undefined {
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return 'timeout'
    }
  }
  if (!(cause instanceof Error) || !FEED_LOG_REASON.test(cause.name)) {
    return undefined
  }
  return cause.name
}

export const fetchFeed: FetchFeed = async (url: HttpUrl): Promise<Result<FetchedFeed, FetchError>> => {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!response.ok) {
      return err(
        fetchFailed(url, `HTTP ${response.status}`, {
          ...withStatus(response.status),
          logReason: 'http_error',
        }),
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!isFeedContentType(contentType)) {
      return err(
        fetchFailed(url, `Unsupported content type: ${contentType || '(empty)'}`, {
          ...withStatus(response.status),
          logReason: 'unsupported_content_type',
        }),
      )
    }

    const bytes = await readBoundedBytes(response, MAX_FEED_BYTES)
    if (!bytes.ok) {
      return bytes
    }

    const decoded = decodeHtmlBytes(bytes.value, contentType)
    if (!decoded.ok) {
      return err(
        fetchFailed(url, decoded.reason, {
          ...withStatus(response.status),
          logReason: 'unsupported_charset',
        }),
      )
    }

    const finalUrl = parseHttpUrl(response.url) ?? url
    return ok({
      requestedUrl: url,
      finalUrl,
      contentType: contentType || 'application/xml',
      xml: decoded.html,
    })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const logReason = thrownLogReason(cause)
    return err(fetchFailed(url, reason, logReason === undefined ? {} : { logReason }))
  }
}
