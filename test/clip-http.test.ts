import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { MAX_HTML_BYTES } from '../src/extract/constants'
import { fetchPage } from '../src/extract/fetch-page'
import { createExtractPipeline } from '../src/extract/pipeline'
import { createTranslatePipeline } from '../src/translate/pipeline'
import {
  err,
  ok,
  parseHttpUrl,
  type ExtractedArticle,
  type FetchPage,
  type HttpUrl,
  type TranslateArticle,
} from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))
const BINDINGS = { OPENAI_API_KEY: 'sk-test' } as Cloudflare.Env

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
  translated?: boolean
  contentHtml?: string
  timingsMs?: { fetch: number; extract: number; translate: number }
  error?: { code: string; message: string; extracted?: ExtractedArticle }
}

function appWithFetch(fetchPageImpl: FetchPage, translateArticle?: TranslateArticle) {
  return createApp({
    translatePipeline: createTranslatePipeline({
      extractPipeline: createExtractPipeline({ fetchPage: fetchPageImpl }),
      ...(translateArticle !== undefined ? { translateArticle } : {}),
    }),
  })
}

async function clip(app: ReturnType<typeof createApp>, url: string): Promise<Response> {
  return app.request(
    '/clip',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    },
    BINDINGS,
  )
}

async function readJson(response: Response): Promise<ClipJson> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('expected JSON object')
  }
  return body as ClipJson
}

describe('POST /clip', () => {
  it('returns Japanese articles without retranslation', async () => {
    const app = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('ja-tech.html'),
      }),
    )
    const response = await clip(app, 'https://example.com/ja/workers-cpu')
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.title).toBe('Cloudflare Workers の CPU 制限')
    expect(body.language).toBe('ja')
    expect(body.translated).toBe(false)
    expect(body.contentHtml).toContain('Paid プラン')
    expect(body.contentHtml).toContain('npx wrangler dev')
    expect(body.timingsMs?.translate).toBeGreaterThanOrEqual(0)
  })

  it('returns Japanese content for an English fixture via the translator', async () => {
    const translateArticle: TranslateArticle = async (extracted) =>
      ok({
        ...extracted,
        title: 'compatibility_date を最新に保つ',
        contentHtml:
          '<h1>compatibility_date を最新に保つ</h1><p>nodejs_compat フラグが必要。</p><pre><code>{"compatibility_date":"2026-09-19"}</code></pre>',
        language: 'ja',
        translated: true,
      })
    const app = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('en-tech.html'),
      }),
      translateArticle,
    )
    const response = await clip(app, 'https://example.com/en/compatibility-date')
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.language).toBe('ja')
    expect(body.translated).toBe(true)
    expect(body.title).toBe('compatibility_date を最新に保つ')
    expect(body.contentHtml).toContain('{"compatibility_date":"2026-09-19"}')
  })

  it('returns 400 for an invalid URL', async () => {
    const app = appWithFetch(async (url) => err({ kind: 'fetch_failed', url, reason: 'unused' }))
    const response = await clip(app, 'ftp://example.com/x')
    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.error?.code).toBe('invalid_url')
    expect(body.error?.message).toContain('ftp://example.com/x')
  })

  it('returns 502 when fetch fails', async () => {
    const app = appWithFetch(async (url) => err({ kind: 'fetch_failed', url, reason: 'HTTP 404' }))
    const response = await clip(app, 'https://example.com/missing')
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
    const response = await clip(app, 'https://example.com/empty')
    expect(response.status).toBe(422)
    const body = await readJson(response)
    expect(body.error?.code).toBe('extract_failed')
  })

  it('returns 503 with extracted article when translation fails', async () => {
    const translateArticle: TranslateArticle = async (extracted) =>
      err({ kind: 'translate_failed', extracted, reason: 'OpenAI HTTP 500' })
    const app = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('en-tech.html'),
      }),
      translateArticle,
    )
    const response = await clip(app, 'https://example.com/en/compatibility-date')
    expect(response.status).toBe(503)
    const body = await readJson(response)
    expect(body.error?.code).toBe('translate_failed')
    expect(body.error?.extracted?.contentHtml).toContain('nodejs_compat')
    expect(body.error?.extracted?.language).toBe('non-ja')
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
