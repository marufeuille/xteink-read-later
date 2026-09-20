import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { MAX_HTML_BYTES } from '../src/extract/constants'
import { fetchPage } from '../src/extract/fetch-page'
import { createExtractPipeline } from '../src/extract/pipeline'
import { createClipPipeline } from '../src/pipeline/clip'
import { createMemoryStore } from '../src/store/memory'
import { createR2Store } from '../src/store/r2'
import { translateArticle as openAiTranslate } from '../src/translate/openai'
import {
  clipJobIdFromUrl,
  err,
  ok,
  parseHttpUrl,
  type ClipPipeline,
  type FetchPage,
  type HttpUrl,
  type TranslateArticle,
} from '../src/types'
import { createFakeQueue, type FakeQueue } from './fake-queue'
import { createFakeR2Bucket } from './fake-r2'
import {
  basicAuthorization,
  bearerAuthorization,
  TEST_BINDINGS,
  TEST_CLIP_TOKEN,
} from './bindings'

const fixtures = dirname(fileURLToPath(import.meta.url))
const BINDINGS = TEST_BINDINGS

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
  id?: string
  jobId?: string
  title?: string
  language?: string
  translated?: boolean
  status?: string
  sourceUrl?: string
  attempt?: number
  epubPath?: string
  timingsMs?: { fetch: number; extract: number; translate: number; epub: number }
  error?: { code: string; message: string; extracted?: { contentHtml?: string; language?: string } }
}

const jaTranslate: TranslateArticle = async (article) =>
  ok({
    ...article,
    language: 'ja',
    translated: article.language !== 'ja',
    title: article.language === 'ja' ? article.title : `${article.title}（日本語）`,
  })

const jaTechPage: FetchPage = async (url) =>
  ok({
    requestedUrl: url,
    finalUrl: url,
    contentType: 'text/html',
    html: fixtureHtml('ja-tech.html'),
  })

function appWithFetch(fetchPageImpl: FetchPage, translateArticle: TranslateArticle = jaTranslate) {
  const store = createMemoryStore()
  const queue = createFakeQueue()
  const clipPipeline = createClipPipeline({
    extractPipeline: createExtractPipeline({ fetchPage: fetchPageImpl }),
    translateArticle,
  })
  const app = createApp({ store, queue })
  const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
  return { app, store, queue, clipPipeline, env }
}

async function clip(
  app: ReturnType<typeof createApp>,
  url: string,
  env: Cloudflare.Env = BINDINGS,
): Promise<Response> {
  return app.request(
    '/clip',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
      body: JSON.stringify({ url }),
    },
    env,
  )
}

async function drain(
  queue: FakeQueue,
  env: Cloudflare.Env,
  deps: { clipPipeline: ClipPipeline; store: ReturnType<typeof createMemoryStore> },
): Promise<void> {
  await queue.drain(env, deps)
}

async function getJob(
  app: ReturnType<typeof createApp>,
  jobId: string,
  env: Cloudflare.Env,
): Promise<Response> {
  return app.request(`/clip/jobs/${jobId}`, { headers: { authorization: bearerAuthorization() } }, env)
}

async function opdsGet(
  app: ReturnType<typeof createApp>,
  path: string,
  env: Cloudflare.Env = BINDINGS,
): Promise<Response> {
  return app.request(path, { headers: { authorization: basicAuthorization() } }, env)
}

async function readJson(response: Response): Promise<ClipJson> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('expected JSON object')
  }
  return body as ClipJson
}

describe('POST /clip', () => {
  it('returns 202 queued without fetching, then the consumer writes EPUB', async () => {
    const bucket = createFakeR2Bucket()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({
        fetchPage: async (url) =>
          ok({
            requestedUrl: url,
            finalUrl: url,
            contentType: 'text/html',
            html: fixtureHtml('ja-tech.html'),
          }),
      }),
      translateArticle: jaTranslate,
    })
    const app = createApp({
      createStore: createR2Store,
      queue,
    })
    const env = { ...TEST_BINDINGS, ARTICLES: bucket, CLIP_QUEUE: queue } as Cloudflare.Env
    const first = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    expect(first.status).toBe(202)
    expect(first.headers.get('location')).toMatch(/^\/clip\/jobs\/job_[a-f0-9]{32}$/)
    const firstBody = await readJson(first)
    expect(firstBody.status).toBe('queued')
    expect(firstBody.jobId).toMatch(/^job_[a-f0-9]{32}$/)
    expect(firstBody.title).toBeUndefined()
    expect(firstBody.epubPath).toBeUndefined()
    expect(firstBody.timingsMs).toBeUndefined()

    const queuedCatalog = await opdsGet(app, '/opds', env)
    expect(await queuedCatalog.text()).not.toContain('<entry>')

    await queue.drain(env, { clipPipeline, createStore: createR2Store })
    const ready = await readJson(await getJob(app, firstBody.jobId ?? '', env))
    expect(ready.status).toBe('ready')
    expect(ready.id).toMatch(/^art_[a-f0-9]{32}$/)
    expect(ready.epubPath).toBe(`/articles/${ready.id}/book.epub`)

    const metaRes = await opdsGet(app, `/articles/${ready.id}`, env)
    expect(metaRes.status).toBe(200)
    const firstMeta = (await metaRes.json()) as { createdAt: string; updatedAt: string; title: string }

    const second = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    expect(second.status).toBe(202)
    const secondQueued = await readJson(second)
    expect(secondQueued.jobId).toBe(firstBody.jobId)
    await queue.drain(env, { clipPipeline, createStore: createR2Store })
    const secondReady = await readJson(await getJob(app, secondQueued.jobId ?? '', env))
    expect(secondReady.id).toBe(ready.id)
    const secondMetaRes = await opdsGet(app, `/articles/${secondReady.id}`, env)
    const secondMeta = (await secondMetaRes.json()) as { createdAt: string; updatedAt: string }
    expect(secondMeta.createdAt).toBe(firstMeta.createdAt)

    const epubRes = await opdsGet(app, secondReady.epubPath ?? '', env)
    expect(epubRes.status).toBe(200)
    expect(epubRes.headers.get('content-type')).toBe('application/epub+zip')

    const deleted = await app.request(
      `/articles/${ready.id}`,
      { method: 'DELETE', headers: { authorization: bearerAuthorization() } },
      env,
    )
    expect(deleted.status).toBe(200)
    expect(await opdsGet(app, secondReady.epubPath ?? '', env)).toMatchObject({ status: 404 })
    expect(
      await app.request(
        `/articles/${ready.id}`,
        { method: 'DELETE', headers: { authorization: bearerAuthorization() } },
        env,
      ),
    ).toMatchObject({
      status: 404,
    })
  })

  it('returns 400 for an invalid URL', async () => {
    const { app, env } = appWithFetch(async (url) => err({ kind: 'fetch_failed', url, reason: 'unused' }))
    const response = await clip(app, 'ftp://example.com/x', env)
    expect(response.status).toBe(400)
    expect((await readJson(response)).error?.code).toBe('invalid_url')
  })

  it('does not fetch in the HTTP handler; fetch_failed lands on the job', async () => {
    let fetched = 0
    const ctx = appWithFetch(async (url) => {
      fetched += 1
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    })
    const response = await clip(ctx.app, 'https://example.com/missing', ctx.env)
    expect(response.status).toBe(202)
    expect(fetched).toBe(0)
    await drain(ctx.queue, ctx.env, ctx)
    expect(fetched).toBe(4)
    const body = await readJson(response)
    const job = await readJson(await getJob(ctx.app, body.jobId ?? '', ctx.env))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('fetch_failed')
    expect(job.error?.extracted).toBeUndefined()
  })

  it('records extract_failed on the job without extracted HTML', async () => {
    const ctx = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('empty.html'),
      }),
    )
    const response = await clip(ctx.app, 'https://example.com/empty', ctx.env)
    expect(response.status).toBe(202)
    await drain(ctx.queue, ctx.env, ctx)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx.app, queued.jobId ?? '', ctx.env))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('extract_failed')
    expect(job.error?.extracted).toBeUndefined()
    const text = JSON.stringify(job)
    expect(text).not.toContain('contentHtml')
  })

  it('records translate_failed on the job when OPENAI_API_KEY is unset', async () => {
    const store = createMemoryStore()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({
        fetchPage: async (url) =>
          ok({
            requestedUrl: url,
            finalUrl: url,
            contentType: 'text/html',
            html: fixtureHtml('en-tech.html'),
          }),
      }),
      translateArticle: openAiTranslate,
    })
    const app = createApp({ store, queue })
    const env = { CLIP_TOKEN: TEST_CLIP_TOKEN, CLIP_QUEUE: queue } as unknown as Cloudflare.Env
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/en/compatibility-date' }),
      },
      env,
    )
    expect(response.status).toBe(202)
    await queue.drain(env, { clipPipeline, store })
    const queued = await readJson(response)
    const job = await readJson(await getJob(app, queued.jobId ?? '', env))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('translate_failed')
    expect(job.error?.extracted).toBeUndefined()
  })

  it('records translate_failed on the job without extracted article', async () => {
    const translateArticle: TranslateArticle = async (extracted) =>
      err({ kind: 'translate_failed', extracted, reason: 'OpenAI HTTP 500' })
    const ctx = appWithFetch(
      async (url) =>
        ok({
          requestedUrl: url,
          finalUrl: url,
          contentType: 'text/html',
          html: fixtureHtml('en-tech.html'),
        }),
      translateArticle,
    )
    const response = await clip(ctx.app, 'https://example.com/en/compatibility-date', ctx.env)
    expect(response.status).toBe(202)
    await drain(ctx.queue, ctx.env, ctx)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx.app, queued.jobId ?? '', ctx.env))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('translate_failed')
    expect(job.error?.extracted).toBeUndefined()
    expect(JSON.stringify(job)).not.toContain('nodejs_compat')
  })

  it('records payload_too_large on the job', async () => {
    const ctx = appWithFetch(async () => err({ kind: 'payload_too_large', bytes: MAX_HTML_BYTES + 1 }))
    const response = await clip(ctx.app, 'https://example.com/huge', ctx.env)
    expect(response.status).toBe(202)
    await drain(ctx.queue, ctx.env, ctx)
    const queued = await readJson(response)
    const job = await readJson(await getJob(ctx.app, queued.jobId ?? '', ctx.env))
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('payload_too_large')
  })

  it('returns 404 for an unknown article, EPUB, and job', async () => {
    const { app, env } = appWithFetch(async (url) => err({ kind: 'fetch_failed', url, reason: 'unused' }))
    const missingId = 'art_0123456789abcdef0123456789abcdef'
    expect((await opdsGet(app, `/articles/${missingId}`, env)).status).toBe(404)
    expect((await opdsGet(app, `/articles/${missingId}/book.epub`, env)).status).toBe(404)
    expect((await opdsGet(app, '/articles/not-an-id', env)).status).toBe(404)
    expect((await getJob(app, 'job_0123456789abcdef0123456789abcdef', env)).status).toBe(404)
    expect((await getJob(app, 'not-a-job', env)).status).toBe(404)
  })

  it('accepts a trailing slash on POST /clip and GET /clip/jobs/:jobId', async () => {
    const ctx = appWithFetch(async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('ja-tech.html'),
      }),
    )
    const response = await ctx.app.request(
      '/clip/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    const queued = await readJson(response)
    expect(queued.status).toBe('queued')
    await drain(ctx.queue, ctx.env, ctx)
    const jobId = queued.jobId
    const job = await ctx.app.request(
      `/clip/jobs/${jobId}/`,
      { headers: { authorization: bearerAuthorization() } },
      ctx.env,
    )
    expect(job.status).toBe(200)
    expect((await readJson(job)).status).toBe('ready')
  })

  it('records epub_failed on the job after one retry', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      const store = createMemoryStore()
      const queue = createFakeQueue()
      const clipPipeline = createClipPipeline({
        extractPipeline: createExtractPipeline({
          fetchPage: async (url) =>
            ok({
              requestedUrl: url,
              finalUrl: url,
              contentType: 'text/html',
              html: fixtureHtml('ja-tech.html'),
            }),
        }),
        translateArticle: jaTranslate,
        buildEpub: async () => {
          throw new Error('zip boom')
        },
      })
      const app = createApp({ store, queue })
      const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
      const response = await clip(app, 'https://example.com/ja/workers-cpu', env)
      expect(response.status).toBe(202)
      await queue.drain(env, { clipPipeline, store })
      const queued = await readJson(response)
      const job = await readJson(await getJob(app, queued.jobId ?? '', env))
      expect(job.status).toBe('failed')
      expect(job.error?.code).toBe('epub_failed')
      expect(job.error?.message).toContain('zip boom')
      expect(logs.some((line) => line.includes('"stage":"epub"') && line.includes('epub_failed'))).toBe(
        true,
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('returns 400 when the JSON body is missing a url string', async () => {
    const { app, env } = appWithFetch(async (url) => err({ kind: 'fetch_failed', url, reason: 'unused' }))
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ href: 'https://example.com/a' }),
      },
      env,
    )
    expect(response.status).toBe(400)
    expect((await readJson(response)).error?.code).toBe('invalid_url')
  })

  it('does not re-enqueue the same URL while queued', async () => {
    const ctx = appWithFetch(jaTechPage)
    const first = await clip(ctx.app, 'https://example.com/ja/workers-cpu', ctx.env)
    const second = await clip(ctx.app, 'https://example.com/ja/workers-cpu', ctx.env)
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(ctx.queue.size).toBe(1)
    expect((await readJson(first)).jobId).toBe((await readJson(second)).jobId)
  })

  it('marks queue_failed and allows the same URL to be re-enqueued', async () => {
    let failSend = true
    const store = createMemoryStore()
    const queue = createFakeQueue({
      onSend: () => {
        if (failSend) {
          failSend = false
          throw new Error('queue unavailable')
        }
      },
    })
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({ fetchPage: jaTechPage }),
      translateArticle: jaTranslate,
    })
    const app = createApp({ store, queue })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
    const failed = await clip(app, 'https://example.com/ja/workers-cpu', env)
    expect(failed.status).toBe(503)
    expect((await readJson(failed)).error?.code).toBe('queue_failed')
    const jobId = await clipJobIdFromUrl(mustUrl('https://example.com/ja/workers-cpu'))
    const failedJob = await store.getJob(jobId)
    expect(failedJob?.status).toBe('failed')
    expect(failedJob?.error?.code).toBe('queue_failed')
    expect(queue.size).toBe(0)

    const retry = await clip(app, 'https://example.com/ja/workers-cpu', env)
    expect(retry.status).toBe(202)
    expect(queue.size).toBe(1)
    await drain(queue, env, { clipPipeline, store })
    expect((await store.getJob(jobId))?.status).toBe('ready')
  })

  it('re-enqueues a queued job that has not been updated for 15 minutes', async () => {
    const ctx = appWithFetch(jaTechPage)
    const jobId = await clipJobIdFromUrl(mustUrl('https://example.com/ja/workers-cpu'))
    await clip(ctx.app, 'https://example.com/ja/workers-cpu', ctx.env)
    const existing = await ctx.store.getJob(jobId)
    if (existing === null) {
      throw new Error('job')
    }
    await ctx.store.putJob({ ...existing, updatedAt: '2000-01-01T00:00:00.000Z' })
    const second = await clip(ctx.app, 'https://example.com/ja/workers-cpu', ctx.env)
    expect(second.status).toBe(202)
    expect(ctx.queue.size).toBe(2)
    expect(ctx.queue.peek()[0]?.runId).not.toBe(ctx.queue.peek()[1]?.runId)
    await drain(ctx.queue, ctx.env, ctx)
    expect((await readJson(await getJob(ctx.app, jobId, ctx.env))).status).toBe('ready')
  })

  it('does not move a ready job back to running on duplicate delivery', async () => {
    const ctx = appWithFetch(jaTechPage)
    await clip(ctx.app, 'https://example.com/ja/workers-cpu', ctx.env)
    await drain(ctx.queue, ctx.env, ctx)
    const jobId = await clipJobIdFromUrl(mustUrl('https://example.com/ja/workers-cpu'))
    const ready = await ctx.store.getJob(jobId)
    if (ready === null || ready.status !== 'ready') {
      throw new Error('ready')
    }
    ctx.queue.push({ jobId: ready.jobId, runId: ready.runId, url: ready.sourceUrl })
    await drain(ctx.queue, ctx.env, ctx)
    expect((await ctx.store.getJob(jobId))?.status).toBe('ready')
    expect((await readJson(await getJob(ctx.app, jobId, ctx.env))).status).toBe('ready')
  })

  it('ignores an old run after a newer enqueue', async () => {
    const ctx = appWithFetch(jaTechPage)
    await clip(ctx.app, 'https://example.com/ja/workers-cpu', ctx.env)
    await drain(ctx.queue, ctx.env, ctx)
    const jobId = await clipJobIdFromUrl(mustUrl('https://example.com/ja/workers-cpu'))
    const first = await ctx.store.getJob(jobId)
    if (first === null) {
      throw new Error('first')
    }
    await clip(ctx.app, 'https://example.com/ja/workers-cpu', ctx.env)
    ctx.queue.push({ jobId: first.jobId, runId: first.runId, url: first.sourceUrl })
    await drain(ctx.queue, ctx.env, ctx)
    const after = await ctx.store.getJob(jobId)
    expect(after?.status).toBe('ready')
    expect(after?.runId).not.toBe(first.runId)
  })

  it('records internal_error after unexpected exceptions exhaust retries', async () => {
    const store = createMemoryStore()
    const queue = createFakeQueue()
    let calls = 0
    const clipPipeline: ClipPipeline = async () => {
      calls += 1
      throw new Error('isolate killed')
    }
    const app = createApp({ store, queue })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
    const response = await clip(app, 'https://example.com/ja/workers-cpu', env)
    expect(response.status).toBe(202)
    await drain(queue, env, { clipPipeline, store })
    expect(calls).toBe(4)
    const jobId = await clipJobIdFromUrl(mustUrl('https://example.com/ja/workers-cpu'))
    const job = await store.getJob(jobId)
    expect(job?.status).toBe('failed')
    expect(job?.error?.code).toBe('internal_error')
  })

  it('accepts Android share payloads as JSON, text/plain, or form body', async () => {
    const fetched: string[] = []
    const ctx = appWithFetch(async (url) => {
      fetched.push(url)
      return ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: fixtureHtml('ja-tech.html'),
      })
    })

    const jsonShare = await ctx.app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: '記事タイトル\nhttps://example.com/ja/workers-cpu' }),
      },
      ctx.env,
    )
    expect(jsonShare.status).toBe(202)
    expect((await readJson(jsonShare)).status).toBe('queued')
    expect(fetched).toEqual([])

    const plain = await ctx.app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', authorization: bearerAuthorization() },
        body: 'https://example.com/ja/workers-cpu',
      },
      ctx.env,
    )
    expect(plain.status).toBe(202)

    const form = await ctx.app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: bearerAuthorization(),
        },
        body: 'url=https%3A%2F%2Fexample.com%2Fja%2Fworkers-cpu',
      },
      ctx.env,
    )
    expect(form.status).toBe(202)
    await drain(ctx.queue, ctx.env, ctx)
    expect(fetched.every((url) => url === 'https://example.com/ja/workers-cpu')).toBe(true)
    expect(fetched.length).toBeGreaterThan(0)
  })

  it('uses a stable jobId for the same normalized URL', async () => {
    const url = mustUrl('https://example.com/ja/workers-cpu')
    expect(await clipJobIdFromUrl(url)).toBe(await clipJobIdFromUrl(url))
    expect(await clipJobIdFromUrl(url)).not.toBe(
      await clipJobIdFromUrl(mustUrl('https://example.com/en/compatibility-date')),
    )
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

  it('fails for a non-HTML content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"ok":true}', {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    try {
      const result = await fetchPage(mustUrl('https://example.com/api'))
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('fetch_failed')
      if (result.error.kind === 'fetch_failed') {
        expect(result.error.reason).toContain('Unsupported content type')
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails when the remote page returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('missing', { status: 404 })),
    )
    try {
      const result = await fetchPage(mustUrl('https://example.com/missing'))
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('fetch_failed')
      if (result.error.kind === 'fetch_failed') {
        expect(result.error.reason).toBe('HTTP 404')
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
