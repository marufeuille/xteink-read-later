import type { FetchError, FetchedPage, FetchPage, HttpUrl, Result } from '../types'
import { err, ok, parseHttpUrl } from '../types'
import { readBoundedBytes } from './bounded-body'
import { FETCH_TIMEOUT_MS, MAX_HTML_BYTES, USER_AGENT } from './constants'
import { decodeHtmlBytes } from './html-encoding'
import { createMediumFeedRecovery } from './sites/medium'
import { withSiteRecoveries } from './sites/recovery'

const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'

export type FetchedText = {
  readonly requestedUrl: HttpUrl
  readonly finalUrl: HttpUrl
  readonly contentType: string
  readonly text: string
}

function isHtmlContentType(contentType: string): boolean {
  if (contentType.length === 0) {
    return true
  }
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return mime === 'text/html' || mime === 'application/xhtml+xml'
}

export async function fetchText(
  url: HttpUrl,
  accept = '*/*',
): Promise<Result<FetchedText, FetchError>> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
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
    const bytes = await readBoundedBytes(response, MAX_HTML_BYTES)
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
      contentType,
      text: decoded.html,
    })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return err({ kind: 'fetch_failed', url, reason })
  }
}

async function fetchHtmlPage(url: HttpUrl): Promise<Result<FetchedPage, FetchError>> {
  const fetched = await fetchText(url, HTML_ACCEPT)
  if (!fetched.ok) {
    return fetched
  }
  const contentType = fetched.value.contentType
  if (!isHtmlContentType(contentType)) {
    return err({
      kind: 'fetch_failed',
      url,
      reason: `Unsupported content type: ${contentType || '(empty)'}`,
    })
  }
  return ok({
    requestedUrl: fetched.value.requestedUrl,
    finalUrl: fetched.value.finalUrl,
    contentType: contentType || 'text/html',
    html: fetched.value.text,
  })
}

// Site-specific fallbacks. Append a recovery when a host blocks ordinary HTML fetches.
export const fetchPage: FetchPage = withSiteRecoveries(fetchHtmlPage, [
  createMediumFeedRecovery(fetchText),
])
