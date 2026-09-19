import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { createExtractPipeline } from '../src/extract/pipeline'
import { fetchPage } from '../src/extract/fetch-page'
import { MAX_HTML_BYTES } from '../src/extract/constants'
import { err, ok, parseHttpUrl, type FetchPage, type HttpUrl } from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))

function fixtureHtml(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

type ClipJson = {
  title?: string
  language?: string
  contentHtml?: string
  timingsMs?: { fetch: number; extract: number }
  error?: { code: string; message: string }
}

function appWithFetch(fetchPageImpl: FetchPage) {
  return createApp({ extractPipeline: createExtractPipeline({ fetchPage: fetchPageImpl }) })
}

async function readJson(response: Response): Promise<ClipJson> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('expected JSON object')
  }
  return body as ClipJson
}

describe('POST /clip', () => {
  it('returns extracted JSON for a Japanese fixture URL', async () => {
    const app = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('ja-tech.html'),
      }),
    )
    const response = await app.request('/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
    })
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.title).toBe('Cloudflare Workers の CPU 制限')
    expect(body.language).toBe('ja')
    expect(body.contentHtml).toContain('Paid プラン')
    expect(body.timingsMs?.fetch).toBeGreaterThanOrEqual(0)
    expect(body.timingsMs?.extract).toBeGreaterThanOrEqual(0)
  })

  it('returns extracted JSON for an English fixture URL', async () => {
    const app = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('en-tech.html'),
      }),
    )
    const response = await app.request('/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/en/compatibility-date' }),
    })
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.title).toBe('Keep compatibility_date current')
    expect(body.language).toBe('non-ja')
    expect(body.contentHtml).toContain('nodejs_compat')
  })

  it('returns 400 for an invalid URL', async () => {
    const app = appWithFetch(async (url) => err({ kind: 'fetch_failed', url, reason: 'unused' }))
    const response = await app.request('/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com/x' }),
    })
    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.error?.code).toBe('invalid_url')
    expect(body.error?.message).toContain('ftp://example.com/x')
  })

  it('returns 502 when fetch fails', async () => {
    const app = appWithFetch(async (url) => err({ kind: 'fetch_failed', url, reason: 'HTTP 404' }))
    const response = await app.request('/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/missing' }),
    })
    expect(response.status).toBe(502)
    const body = await readJson(response)
    expect(body.error?.code).toBe('fetch_failed')
    expect(body.error?.message).toContain('HTTP 404')
  })

  it('returns 422 when extraction fails', async () => {
    const app = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('empty.html'),
      }),
    )
    const response = await app.request('/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/empty' }),
    })
    expect(response.status).toBe(422)
    const body = await readJson(response)
    expect(body.error?.code).toBe('extract_failed')
  })
})

describe('fetchPage', () => {
  it('returns payload_too_large when the HTML stream exceeds the cap', async () => {
    const chunk = new Uint8Array(100_000)
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 20; i += 1) {
            controller.enqueue(chunk)
          }
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/html' } },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )
    try {
      const result = await fetchPage(mustUrl('https://example.com/huge'))
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('payload_too_large')
      if (result.error.kind === 'payload_too_large') {
        expect(result.error.bytes).toBeGreaterThan(MAX_HTML_BYTES)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('decodes Shift_JIS HTML from Content-Type charset', async () => {
    const nihongo = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])
    const ascii = new TextEncoder().encode(
      '<!DOCTYPE html><html lang="ja"><head><meta charset="Shift_JIS"><title>x</title></head><body><article><h1>x</h1><p>',
    )
    const tail = new TextEncoder().encode(
      ' body text for extraction length body text for extraction length body text for extraction length.</p></article></body></html>',
    )
    const sjis = new Uint8Array(ascii.length + nihongo.length * 8 + tail.length)
    let i = 0
    sjis.set(ascii, i)
    i += ascii.length
    for (let n = 0; n < 8; n += 1) {
      sjis.set(nihongo, i)
      i += nihongo.length
    }
    sjis.set(tail, i)

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(sjis, {
            headers: { 'content-type': 'text/html; charset=Shift_JIS' },
          }),
      ),
    )
    try {
      const result = await fetchPage(mustUrl('https://example.com/sjis'))
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.value.html).toContain('日本語')
      expect(result.value.html).not.toContain('\uFFFD')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails explicitly for an unsupported charset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body>hi</body></html>', {
            headers: { 'content-type': 'text/html; charset=x-unknown-set' },
          }),
      ),
    )
    try {
      const result = await fetchPage(mustUrl('https://example.com/unknown-charset'))
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('fetch_failed')
      if (result.error.kind === 'fetch_failed') {
        expect(result.error.reason).toContain('Unsupported HTML charset')
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
