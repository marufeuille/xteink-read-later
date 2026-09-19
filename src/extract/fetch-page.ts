import type { FetchError, FetchedPage, FetchPage, HttpUrl, PayloadTooLargeError, Result } from '../types'
import { err, ok, parseHttpUrl } from '../types'
import { FETCH_TIMEOUT_MS, MAX_HTML_BYTES, USER_AGENT } from './constants'

function isHtmlContentType(contentType: string): boolean {
  if (contentType.length === 0) {
    return true
  }
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return mime === 'text/html' || mime === 'application/xhtml+xml'
}

async function readBoundedHtml(
  response: Response,
): Promise<Result<string, PayloadTooLargeError>> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (Number.isFinite(bytes) && bytes > MAX_HTML_BYTES) {
      return err({ kind: 'payload_too_large', bytes })
    }
  }

  const body = response.body
  if (body === null) {
    return ok('')
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value === undefined) {
        continue
      }
      received += value.byteLength
      if (received > MAX_HTML_BYTES) {
        await reader.cancel()
        return err({ kind: 'payload_too_large', bytes: received })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return ok(new TextDecoder('utf-8').decode(bytes))
}

export const fetchPage: FetchPage = async (url: HttpUrl): Promise<Result<FetchedPage, FetchError>> => {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
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
    if (!isHtmlContentType(contentType)) {
      return err({
        kind: 'fetch_failed',
        url,
        reason: `Unsupported content type: ${contentType || '(empty)'}`,
      })
    }

    const html = await readBoundedHtml(response)
    if (!html.ok) {
      return html
    }

    const finalUrl = parseHttpUrl(response.url) ?? url
    return ok({
      requestedUrl: url,
      finalUrl,
      contentType: contentType || 'text/html',
      html: html.value,
    })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return err({ kind: 'fetch_failed', url, reason })
  }
}
