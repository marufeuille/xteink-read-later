import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFeed } from '../src/feeds/fetch'
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
