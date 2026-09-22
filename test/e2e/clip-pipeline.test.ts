import { unzipSync, strFromU8 } from 'fflate'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { MAX_HTML_BYTES } from '../../src/extract/constants'
import { buildEpub } from '../../src/epub/build-epub'
import { createClipPipeline } from '../../src/pipeline/clip'
import { createMemoryStore } from '../../src/store/memory'
import { OPENAI_CHAT_URL } from '../../src/translate/constants'
import { articleIdFromCanonicalUrl, asClipJobId, parseHttpUrl, type BuildEpub } from '../../src/types'
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
  stages?: { stage: string; errorKind?: string }[]
  error?: { code: string; message: string; extracted?: { contentHtml?: string; language?: string } }
}

function app(options: { readonly buildEpub?: BuildEpub } = {}) {
  const store = createMemoryStore()
  const queue = createFakeQueue()
  const clipPipeline = createClipPipeline({
    ...(options.buildEpub === undefined ? {} : { buildEpub: options.buildEpub }),
  })
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
    expect(job.stages?.map((stage) => stage.stage)).toEqual([
      'queue',
      'fetch',
      'extract',
      'translate',
      'epub',
      'classify',
      'queue',
    ])
    expect(JSON.stringify(job.stages)).not.toContain('example.com')
    expect(JSON.stringify(job.stages)).not.toContain('wrangler')
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
    expect(chapter).not.toContain('\uE000')
    expect(chapter).not.toContain('\uE001')

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

  it('keeps nested emphasis readable instead of leaking *?0?* slot markers', async () => {
    const pageUrl = 'https://example.com/ja/self-repair-loop'
    const { fetchedUrls } = installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('emphasis-nested.html') } },
    })
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('ready')
    expect(fetchedUrls).toEqual([pageUrl])

    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(epubResponse.status).toBe(200)
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('人間がボトルネック')
    expect(chapter).toContain('自己修正ループ')
    expect(chapter).toContain('Claude Codeだけ')
    expect(chapter).toContain('公式ドキュメント')
    expect(chapter).toContain('/goal')
    expect(chapter).toContain('<strong>')
    expect(chapter).toContain('<em>')
    expect(chapter).toContain('<code>/goal</code>')
    expect(chapter).not.toContain('\uE000')
    expect(chapter).not.toContain('\uE001')
    expect(chapter).not.toMatch(/\*\?0\?\*/)
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
      openai: async (request) => {
        const body = (await request.json()) as Record<string, unknown>
        expect(body.model).toBe('gpt-5.6-luna')
        expect(body.temperature).toBeUndefined()
        expect(body.reasoning_effort).toBe('none')
        expect(body.max_completion_tokens).toBe(16_000)
        return openaiMessageResponse(
          'compatibility_date を最新に保つ',
          '# compatibility_date を最新に保つ\n\nnodejs_compat が必要。\n\n```\n{"compatibility_date":"2026-09-19"}\n```',
        )
      },
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

  it('retries EPUB generation without calling OpenAI again', async () => {
    const pageUrl = 'https://example.com/en/compatibility-date'
    let epubCalls = 0
    const { fetchedUrls } = installNetworkMock({
      pages: { [pageUrl]: { html: fixtureHtml('en-tech.html') } },
      openai: async () => openaiMessageResponse('一度だけ', '翻訳本文はここ。nodejs_compat が必要。'),
    })
    const ctx = app({
      buildEpub: async (article) => {
        epubCalls += 1
        if (epubCalls === 1) {
          throw new Error('zip boom')
        }
        return buildEpub(article)
      },
    })
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('ready')
    expect(epubCalls).toBe(2)
    expect(fetchedUrls.filter((url) => url === OPENAI_CHAT_URL)).toEqual([OPENAI_CHAT_URL])
    const jobId = queued.jobId
    if (jobId === undefined) {
      throw new Error('jobId')
    }
    expect(await ctx.store.getClipCheckpoint(asClipJobId(jobId))).toBeNull()
    expect(JSON.stringify(job)).not.toContain('翻訳本文はここ')
    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('翻訳本文はここ')
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
    const articleMeta = (await meta.json()) as { translated: boolean; title: string }
    expect(articleMeta.translated).toBe(true)
    expect(articleMeta.title).toBe(
      'Jev Engineering: Full 10-Step Roadmap to Set Up and Use a New Brain for AI (from scratch)',
    )
    expect(articleMeta.title).not.toContain('Xユーザー')

    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    expect(opf).toContain(
      'Jev Engineering: Full 10-Step Roadmap to Set Up and Use a New Brain for AI (from scratch)',
    )
    expect(opf).not.toContain('Xユーザー')
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
      '/opds/clip/2026-04-12',
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

  it('clips a Medium article from the author feed when the page is blocked', async () => {
    const pageUrl = 'https://medium.com/@Ada/agentic-stack-98fbaee9ad10'
    const { fetchedUrls } = installNetworkMock({
      pages: {
        [pageUrl]: { html: '<html><title>Attention Required! | Cloudflare</title></html>', status: 403 },
        'https://medium.com/feed/@Ada': {
          html: fixtureHtml('medium-author-feed.xml'),
          contentType: 'text/xml; charset=utf-8',
        },
      },
    })
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('ready')
    expect(fetchedUrls).toEqual([pageUrl, 'https://medium.com/feed/@Ada'])

    const meta = await ctx.hono.request(
      `/articles/${job.id}`,
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(meta.status).toBe(200)
    const stored = (await meta.json()) as { title: string; author: string | null }
    expect(stored.title).toBe('エージェントデータスタック')
    expect(stored.author).toBe('Ada')

    const epubResponse = await ctx.hono.request(
      job.epubPath ?? '',
      { headers: { authorization: basicAuthorization() } },
      ctx.env,
    )
    expect(epubResponse.status).toBe(200)
    const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('指標の定義はベンダー')
    expect(chapter).toContain('柱 1: Git で管理する定義')
    expect(chapter).toContain('metric: revenue')
  })

  it('does not retry a Medium page when the author feed has no full article', async () => {
    const pageUrl = 'https://medium.com/@Ada/agentic-stack-98fbaee9ad10'
    const truncated = fixtureHtml('medium-author-feed.xml').replace(
      '指標の定義はベンダーの中に置かず、リポジトリの宣言ファイルとして扱う。',
      'Read the full story on Medium.',
    )
    const { fetchedUrls } = installNetworkMock({
      pages: {
        [pageUrl]: { html: 'blocked', status: 403 },
        'https://medium.com/feed/@Ada': {
          html: truncated,
          contentType: 'text/xml; charset=utf-8',
        },
      },
    })
    const ctx = app()
    const response = await clipAndDrain(ctx, pageUrl)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx, queued.jobId ?? ''))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('fetch_failed')
    expect(job.error?.message).toContain('Medium feed did not include the full article')
    expect(fetchedUrls).toEqual([pageUrl, 'https://medium.com/feed/@Ada'])
  })
})
