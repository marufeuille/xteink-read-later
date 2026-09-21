import { readBoundedBytes } from '../extract/bounded-body'
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../extract/constants'
import { decodeHtmlBytes } from '../extract/html-encoding'
import type { FetchError, FetchedFeed, FetchFeed, HttpUrl, Result } from '../types'
import { err, MAX_FEED_BYTES, ok, parseHttpUrl } from '../types'
import { isFeedContentType } from './parse'

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
      return err({
        kind: 'fetch_failed',
        url,
        reason: `HTTP ${response.status}`,
      })
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!isFeedContentType(contentType)) {
      return err({
        kind: 'fetch_failed',
        url,
        reason: `Unsupported content type: ${contentType || '(empty)'}`,
      })
    }

    const bytes = await readBoundedBytes(response, MAX_FEED_BYTES)
    if (!bytes.ok) {
      return bytes
    }

    const decoded = decodeHtmlBytes(bytes.value, contentType)
    if (!decoded.ok) {
      return err({
        kind: 'fetch_failed',
        url,
        reason: decoded.reason,
      })
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
    return err({ kind: 'fetch_failed', url, reason })
  }
}
