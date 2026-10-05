import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFeed } from '../src/feeds/fetch'
import { feedCollectionErrorLog, logFeed } from '../src/log'
import { MAX_FEED_BYTES, parseHttpUrl, type HttpUrl } from '../src/types'

const FEED_URL = 'https://example.com/large.xml'
const TWO_MB_CLASS_BYTES = 2_100_000

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function rssBytes(total: number): Uint8Array {
  const prefix = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Large</title><link>https://example.com/</link><item><title>Post</title><link>https://example.com/p</link><description>',
  )
  const suffix = new TextEncoder().encode('</description></item></channel></rss>')
  if (total < prefix.length + suffix.length) {
    throw new Error(`rss fixture needs at least ${prefix.length + suffix.length} bytes`)
  }
  const body = new Uint8Array(total)
  body.set(prefix, 0)
  body.fill(0x61, prefix.length, total - suffix.length)
  body.set(suffix, total - suffix.length)
  return body
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchFeed payload cap', () => {
  it('keeps the feed cap at 3MB so ~2MB bodies fit', () => {
    expect(MAX_FEED_BYTES).toBe(3_000_000)
    expect(TWO_MB_CLASS_BYTES).toBeGreaterThan(1_000_000)
    expect(TWO_MB_CLASS_BYTES).toBeLessThanOrEqual(MAX_FEED_BYTES)
  })

  it('accepts a ~2.1MB feed that used to exceed the 1MB cap', async () => {
    const bytes = rssBytes(TWO_MB_CLASS_BYTES)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'application/rss+xml' } })),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(new TextEncoder().encode(result.value.xml).byteLength).toBe(TWO_MB_CLASS_BYTES)
  })

  it('returns payload_too_large when content-length exceeds the cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<rss/>', {
            headers: {
              'content-type': 'application/rss+xml',
              'content-length': String(MAX_FEED_BYTES + 1),
            },
          }),
      ),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.kind).toBe('payload_too_large')
    if (result.error.kind === 'payload_too_large') {
      expect(result.error.bytes).toBe(MAX_FEED_BYTES + 1)
    }
  })

  it('returns payload_too_large when the stream exceeds the cap', async () => {
    const chunk = new Uint8Array(100_000)
    let sent = 0
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (sent > MAX_FEED_BYTES) {
            controller.close()
            return
          }
          controller.enqueue(chunk)
          sent += chunk.byteLength
        },
      }),
      { headers: { 'content-type': 'application/rss+xml' } },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.kind).toBe('payload_too_large')
    if (result.error.kind === 'payload_too_large') {
      expect(result.error.bytes).toBeGreaterThan(MAX_FEED_BYTES)
    }
  })
})

describe('fetchFeed failure log fields', () => {
  const secretUrl = 'https://user:secret-token@joereis.substack.com/feed?token=query-secret'
  const rawBody = '<rss>raw body token=super-secret-token</rss>'

  function loggedFailure(error: { readonly kind: string }): Record<string, unknown> {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    logFeed({
      stage: 'collect',
      durationMs: 1,
      ...feedCollectionErrorLog(error),
    })
    const value = vi.mocked(console.log).mock.calls.at(-1)?.[0]
    expect(typeof value).toBe('object')
    expect(value).not.toBeNull()
    return value as Record<string, unknown>
  }

  it('records the HTTP status and a short reason without the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(rawBody, {
            status: 503,
            headers: { 'content-type': `text/html; token=super-secret-token; url=${secretUrl}` },
          }),
      ),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'fetch_failed') {
      return
    }
    expect(result.error.reason).toBe('HTTP 503')
    expect(result.error.statusCode).toBe(503)
    expect(loggedFailure(result.error)).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      statusCode: 503,
      reason: 'http_error',
    })
    const text = JSON.stringify(loggedFailure(result.error))
    expect(text).not.toContain('raw body')
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('https://')
    expect(text).not.toContain('joereis.substack.com')
  })

  it('keeps a 200 status when the content type is not a feed and drops the header value', async () => {
    const contentType = `application/json; charset=utf-8; token=super-secret-token; url=${secretUrl}`
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(`{"body":${JSON.stringify(rawBody)}}`, {
            status: 200,
            headers: { 'content-type': contentType },
          }),
      ),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'fetch_failed') {
      return
    }
    expect(result.error.reason).toBe(`Unsupported content type: ${contentType}`)
    expect(loggedFailure(result.error)).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      statusCode: 200,
      reason: 'unsupported_content_type',
    })
    const text = JSON.stringify(loggedFailure(result.error))
    expect(text).not.toContain('application/json')
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('raw body')
    expect(text).not.toContain(secretUrl)
  })

  it('records unsupported charset without the charset token or body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(rawBody, {
            status: 200,
            headers: { 'content-type': 'application/rss+xml; charset=super-secret-token' },
          }),
      ),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'fetch_failed') {
      return
    }
    expect(result.error.reason).toContain('Unsupported HTML charset:')
    expect(loggedFailure(result.error)).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      statusCode: 200,
      reason: 'unsupported_charset',
    })
    const text = JSON.stringify(loggedFailure(result.error))
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('raw body')
    expect(text).not.toContain('Unsupported HTML charset')
  })

  it('omits statusCode for a timeout and does not log the exception message', async () => {
    const cause = new Error(`The operation was aborted due to timeout ${secretUrl} ${rawBody}`)
    cause.name = 'TimeoutError'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw cause
      }),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'fetch_failed') {
      return
    }
    expect(result.error.reason).toContain(secretUrl)
    expect(result.error.statusCode).toBeUndefined()
    expect(loggedFailure(result.error)).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      reason: 'timeout',
    })
    expect(JSON.stringify(loggedFailure(result.error))).not.toContain('https://')
    expect(JSON.stringify(loggedFailure(result.error))).not.toContain('raw body')
  })

  it('logs a network exception name and drops a message that contains a URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`Network connection lost. ${secretUrl} ${rawBody}`)
      }),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))

    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'fetch_failed') {
      return
    }
    expect(result.error.statusCode).toBeUndefined()
    expect(loggedFailure(result.error)).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      reason: 'TypeError',
    })
    const text = JSON.stringify(loggedFailure(result.error))
    expect(text).not.toContain('https://')
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('raw body')
    expect(text).not.toContain('Network connection lost')
  })

  it('omits reason when the thrown value has no safe exception name', async () => {
    const cause = new Error(secretUrl)
    cause.name = 'https://joereis.substack.com/feed?token=query-secret'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw cause
      }),
    )

    const named = await fetchFeed(mustUrl(FEED_URL))
    expect(named.ok).toBe(false)
    if (!named.ok && named.error.kind === 'fetch_failed') {
      expect(loggedFailure(named.error)).toEqual({
        message: 'feed collect fetch_failed',
        event: 'feed',
        stage: 'collect',
        durationMs: 1,
        errorKind: 'fetch_failed',
      })
      expect(JSON.stringify(loggedFailure(named.error))).not.toContain('token')
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw secretUrl
      }),
    )
    const thrown = await fetchFeed(mustUrl(FEED_URL))
    expect(thrown.ok).toBe(false)
    if (!thrown.ok && thrown.error.kind === 'fetch_failed') {
      expect(thrown.error.statusCode).toBeUndefined()
      expect(loggedFailure(thrown.error)).toEqual({
        message: 'feed collect fetch_failed',
        event: 'feed',
        stage: 'collect',
        durationMs: 1,
        errorKind: 'fetch_failed',
      })
      expect(JSON.stringify(loggedFailure(thrown.error))).not.toContain('https://')
    }
  })

  it('maps AbortError from the timeout signal to timeout without a status', async () => {
    const cause = new Error(`aborted ${secretUrl}`)
    cause.name = 'AbortError'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw cause
      }),
    )

    const result = await fetchFeed(mustUrl(FEED_URL))
    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'fetch_failed') {
      return
    }
    expect(loggedFailure(result.error)).toEqual({
      message: 'feed collect fetch_failed',
      event: 'feed',
      stage: 'collect',
      durationMs: 1,
      errorKind: 'fetch_failed',
      reason: 'timeout',
    })
    expect(result.error).not.toHaveProperty('statusCode')
  })
})
