import { unzipSync, strFromU8 } from 'fflate'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { MAX_HTML_BYTES } from '../../src/extract/constants'
import { createClipPipeline } from '../../src/pipeline/clip'
import { createMemoryStore } from '../../src/store/memory'
import { OPENAI_CHAT_URL } from '../../src/translate/constants'
import { basicAuthorization, bearerAuthorization, TEST_BINDINGS } from '../bindings'
import { installNetworkMock, openaiMessageResponse } from './mock-network'

const fixtures = dirname(fileURLToPath(import.meta.url))
const BINDINGS = TEST_BINDINGS

function fixtureHtml(name: string): string {
  return readFileSync(join(fixtures, '..', 'fixtures', name), 'utf8')
}

type ClipJson = {
  id?: string
  title?: string
  language?: string
  translated?: boolean
  status?: string
  epubPath?: string
  timingsMs?: { fetch: number; extract: number; translate: number; epub: number }
  error?: { code: string; message: string; extracted?: { contentHtml?: string; language?: string } }
}

function app() {
  return createApp({
    clipPipeline: createClipPipeline(),
    store: createMemoryStore(),
  })
}

async function clip(hono: ReturnType<typeof createApp>, url: string, env: Cloudflare.Env = BINDINGS) {
  return hono.request(
    '/clip',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
      body: JSON.stringify({ url }),
    },
    env,
  )
}

async function readJson(response: Response): Promise<ClipJson> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('expected JSON object')
  }
  return body as ClipJson
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clip pipeline E2E (fixture network)', () => {
  it('turns a Japanese URL into an EPUB without calling OpenAI', async () => {
    const pageUrl = 'https://example.com/ja/workers-cpu'
    const { fetchedUrls } = installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('ja-tech.html') } },
    })
    const hono = app()
    const response = await clip(hono, pageUrl)
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.status).toBe('ready')
    expect(body.translated).toBe(false)
    expect(body.language).toBe('ja')
    expect(body.title).toBe('Cloudflare Workers の CPU 制限')
    expect(body.epubPath).toMatch(/^\/articles\/art_[a-f0-9]{32}\/book\.epub$/)
    expect(fetchedUrls).toEqual([pageUrl])

    const epubResponse = await hono.request(
      body.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(epubResponse.status).toBe(200)
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    expect(strFromU8(files['META-INF/container.xml'] ?? new Uint8Array())).toContain(
      'OEBPS/content.opf',
    )
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('npx wrangler dev')
    expect(chapter).toMatch(/<pre[^>]*>\s*<code>npx wrangler dev<\/code>\s*<\/pre>/)

    const meta = await hono.request(
      `/articles/${body.id}`,
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    expect(meta.status).toBe(200)
    expect(((await meta.json()) as { title: string }).title).toBe(body.title)
  })

  it('translates an English URL with a mocked OpenAI response', async () => {
    const pageUrl = 'https://example.com/en/compatibility-date'
    const { fetchedUrls } = installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('en-tech.html') } },
      openai: async () =>
        openaiMessageResponse(
          'compatibility_date を最新に保つ',
          '# compatibility_date を最新に保つ\n\nnodejs_compat が必要。\n\n```\n{"compatibility_date":"2026-09-19"}\n```',
        ),
    })
    const hono = app()
    const response = await clip(hono, pageUrl)
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.translated).toBe(true)
    expect(body.language).toBe('ja')
    expect(body.title).toBe('compatibility_date を最新に保つ')
    expect(fetchedUrls).toEqual([pageUrl, OPENAI_CHAT_URL])

    const epubResponse = await hono.request(
      body.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      BINDINGS,
    )
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('nodejs_compat')
    expect(chapter).toContain('<pre')
    expect(chapter).toContain('<code')
    expect(chapter).toContain('{&quot;compatibility_date&quot;:&quot;2026-09-19&quot;}')
  })

  it('keeps the extracted article when the OpenAI mock fails', async () => {
    const pageUrl = 'https://example.com/en/compatibility-date'
    installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('en-tech.html') } },
      openai: async () => new Response('nope', { status: 500 }),
    })
    const response = await clip(app(), pageUrl)
    expect(response.status).toBe(503)
    const body = await readJson(response)
    expect(body.error?.code).toBe('translate_failed')
    expect(body.error?.extracted?.language).toBe('non-ja')
    expect(body.error?.extracted?.contentHtml).toContain('nodejs_compat')
    expect(body.error?.extracted?.contentHtml).toContain('<pre')
  })

  it('rejects oversize HTML reported by the fixture server', async () => {
    const pageUrl = 'https://example.com/huge'
    installNetworkMock({
      pages: {
        [pageUrl]: {
          html: '<html></html>',
          headers: { 'content-length': String(MAX_HTML_BYTES + 1) },
        },
      },
    })
    const response = await clip(app(), pageUrl)
    expect(response.status).toBe(413)
    expect((await readJson(response)).error?.code).toBe('payload_too_large')
  })
})
