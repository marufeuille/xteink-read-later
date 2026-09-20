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
import { articleIdFromCanonicalUrl, parseHttpUrl } from '../../src/types'
import { basicAuthorization, bearerAuthorization, TEST_BINDINGS } from '../bindings'
import { createFakeQueue } from '../fake-queue'
import { installNetworkMock, openaiMessageResponse } from './mock-network'

const fixtures = dirname(fileURLToPath(import.meta.url))
const BINDINGS = TEST_BINDINGS

function fixtureHtml(name: string): string {
  return readFileSync(join(fixtures, '..', 'fixtures', name), 'utf8')
}

type ClipJson = {
  id?: string
  jobId?: string
  title?: string
  language?: string
  translated?: boolean
  status?: string
  epubPath?: string
  error?: { code: string; message: string; extracted?: { contentHtml?: string; language?: string } }
}

function app() {
  const store = createMemoryStore()
  const queue = createFakeQueue()
  const clipPipeline = createClipPipeline()
  const hono = createApp({ store, queue })
  const env = { ...BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
  return { hono, store, queue, clipPipeline, env }
}

async function clip(hono: ReturnType<typeof createApp>, url: string, env: Cloudflare.Env) {
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

async function clipAndDrain(ctx: ReturnType<typeof app>, url: string) {
  const response = await clip(ctx.hono, url, ctx.env)
  await ctx.queue.drain(ctx.env, { clipPipeline: ctx.clipPipeline, store: ctx.store })
  return response
}

async function readJson(response: Response): Promise<ClipJson> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('expected JSON object')
  }
  return body as ClipJson
}

async function getJob(ctx: ReturnType<typeof app>, jobId: string) {
  return ctx.hono.request(
    `/clip/jobs/${jobId}`,
    { headers: { authorization: bearerAuthorization() } },
    ctx.env,
  )
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
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    expect(queued.status).toBe('queued')
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('ready')
    expect(job.epubPath).toMatch(/^\/articles\/art_[a-f0-9]{32}\/book\.epub$/)
    expect(fetchedUrls).toEqual([pageUrl])

    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(epubResponse.status).toBe(200)
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    expect(strFromU8(files['META-INF/container.xml'] ?? new Uint8Array())).toContain(
      'OEBPS/content.opf',
    )
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('npx wrangler dev')
    expect(chapter).toMatch(/<pre[^>]*>\s*<code>npx wrangler dev<\/code>\s*<\/pre>/)

    const meta = await ctx.hono.request(
      `/articles/${job.id}`,
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(meta.status).toBe(200)
    const stored = (await meta.json()) as { title: string; classification: { status: string } }
    expect(stored.title).toBe('Cloudflare Workers の CPU 制限')
    expect(stored.classification.status).toBe('skipped')
  })

  it('includes the clip jobId on pipeline stage logs', async () => {
    const pageUrl = 'https://example.com/ja/workers-cpu'
    installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('ja-tech.html') } },
    })
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      const ctx = app()
      const response = await clipAndDrain(ctx, pageUrl)
      const queued = await readJson(response)
      const events = logs
        .map((line) => JSON.parse(line) as { event?: string; stage?: string; jobId?: string })
        .filter((entry) => entry.event === 'pipeline')
      expect(events.some((entry) => entry.stage === 'fetch')).toBe(true)
      expect(events.some((entry) => entry.stage === 'extract')).toBe(true)
      expect(events.some((entry) => entry.stage === 'epub')).toBe(true)
      for (const entry of events) {
        expect(entry.jobId).toBe(queued.jobId)
        expect(JSON.stringify(entry)).not.toContain('npx wrangler dev')
      }
    } finally {
      spy.mockRestore()
    }
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
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('ready')
    expect(fetchedUrls).toEqual([pageUrl, OPENAI_CHAT_URL])

    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('nodejs_compat')
    expect(chapter).toContain('<pre')
    expect(chapter).toContain('<code')
    expect(chapter).toContain('{&quot;compatibility_date&quot;:&quot;2026-09-19&quot;}')
  })

  it('translates an English X article even when the page html lang is ja', async () => {
    const pageUrl = 'https://x.com/0xCodila/status/2100984487802708306'
    const { fetchedUrls } = installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('x-article-ja-ui.html') } },
      openai: async () =>
        openaiMessageResponse(
          'Jev エンジニアリング',
          '# Jev エンジニアリング\n\nジェボンズのパラドックスは、資源の利用効率が上がると消費全体が増えるという規則である。\n\n```\nGoal: Compare three AI-agent tools in a morning briefing.\n```',
        ),
    })
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('ready')
    expect(fetchedUrls).toEqual([pageUrl, OPENAI_CHAT_URL])

    const meta = await ctx.hono.request(
      `/articles/${job.id}`,
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(meta.status).toBe(200)
    expect(((await meta.json()) as { translated: boolean }).translated).toBe(true)

    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('ジェボンズのパラドックス')
    expect(chapter).toContain('Goal: Compare three AI-agent tools')
    expect(chapter).not.toContain('The Jevons Paradox is a rule')
  })

  it('keeps the extract title when mock OpenAI titles change across two clips', async () => {
    const pageUrl = 'https://example.com/en/compatibility-date'
    const extractTitle = 'Keep compatibility_date current'
    const modelTitles = ['モデル見出しA', 'モデル見出しB']
    let openaiCalls = 0
    installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('en-tech.html') } },
      openai: async () => {
        const title = modelTitles[openaiCalls] ?? 'モデル見出しC'
        openaiCalls += 1
        return openaiMessageResponse(title, `# ${title}\n\nnodejs_compat が必要。`)
      },
    })
    const ctx = app()
    const first = await clipAndDrain(ctx, pageUrl)
    expect(first.status).toBe(202)
    const firstQueued = await readJson(first)
    const firstJob = await readJson(await getJob(ctx, firstQueued.jobId ?? ''))
    expect(firstJob.status).toBe('ready')

    const second = await clipAndDrain(ctx, pageUrl)
    expect(second.status).toBe(202)
    const secondQueued = await readJson(second)
    const secondJob = await readJson(await getJob(ctx, secondQueued.jobId ?? ''))
    expect(secondJob.status).toBe('ready')
    expect(secondJob.id).toBe(firstJob.id)
    expect(openaiCalls).toBe(2)

    const canonical = parseHttpUrl(pageUrl)
    if (canonical === null) {
      throw new Error(pageUrl)
    }
    const expectedId = await articleIdFromCanonicalUrl(canonical)
    expect(secondJob.id).toBe(expectedId)

    const meta = await ctx.hono.request(
      `/articles/${secondJob.id}`,
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(meta.status).toBe(200)
    expect(((await meta.json()) as { title: string }).title).toBe(extractTitle)

    const catalog = await ctx.hono.request(
      '/opds',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    const opds = await catalog.text()
    expect(opds).toContain(`<title>${extractTitle}</title>`)
    expect(opds).not.toContain('モデル見出しA')
    expect(opds).not.toContain('モデル見出しB')

    const epubResponse = await ctx.hono.request(
      secondJob.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(epubResponse.status).toBe(200)
    expect(epubResponse.headers.get('content-disposition')).toBe(`attachment; filename="${expectedId}.epub"`)
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(opf).toContain(`<dc:title>${extractTitle}</dc:title>`)
    expect(chapter).toContain(`<title>${extractTitle}</title>`)
    expect(opf).not.toContain('モデル見出しA')
    expect(opf).not.toContain('モデル見出しB')
    expect(chapter).not.toContain(`<title>モデル見出し`)
  })

  it('drops img and NUL from EPUB after a mocked OpenAI markdown reply', async () => {
    const pageUrl = 'https://example.com/en/compatibility-date'
    installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('en-tech.html') } },
      openai: async () =>
        openaiMessageResponse(
          'ダミー見出し',
          'Dummy body text for the chapter.\n\0More dummy text.\n\nSee ![SVG chart caption](https://example.com/chart.svg) after the dummy paragraph.',
        ),
    })
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter.includes('\u0000')).toBe(false)
    expect(chapter).not.toMatch(/<img\b/i)
    expect(chapter).not.toContain('example.com/chart.svg')
    expect(chapter).toContain('Dummy body text for the chapter.')
    expect(chapter).toContain('SVG chart caption')
  })

  it('keeps translate_failed off the HTTP response and off the job body', async () => {
    const pageUrl = 'https://example.com/en/compatibility-date'
    installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('en-tech.html') } },
      openai: async () => new Response('nope', { status: 500 }),
    })
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    expect(queued.error).toBeUndefined()
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('translate_failed')
    expect(job.error?.extracted).toBeUndefined()
    expect(JSON.stringify(job)).not.toContain('nodejs_compat')
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
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('payload_too_large')
  })
})
