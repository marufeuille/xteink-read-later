import { Hono, type Context } from 'hono'
import { clipTokenAuthorized, opdsBasicAuthorized, unauthorizedResponse } from './http/auth'
import { toClipJobBody, toClipQueuedBody } from './http/clip-job'
import { parseClipUrl } from './extract/parse-clip-url'
import { parseClipShareText } from './http/clip-request'
import { errorMessage, toErrorResponse } from './http/error-response'
import { parsePurchasedBookForm } from './http/purchased-book'
import { isActiveClipJob } from './job/clip'
import { logPipeline } from './log'
import { buildOpdsCatalog, OPDS_CATALOG_TYPE, parseOpdsDownloadFile } from './opds/catalog'
import { createR2Store } from './store/r2'
import type {
  AppEnv,
  ArticleId,
  ArticleStore,
  ClipQueueMessage,
  ClipQueuedJob,
  CreateArticleStore,
  EpubBytes,
  PurchasedBookBody,
} from './types'
import {
  articleEpubKey,
  articleIdFromBytes,
  asEpubBytes,
  clipJobIdFromUrl,
  isArticleId,
  isClipJobId,
  newClipRunId,
  parseHttpUrl,
  purchasedCanonicalUrl,
} from './types'

function epubFileResponse(id: ArticleId, epub: EpubBytes): Response {
  return new Response(epub, {
    status: 200,
    headers: {
      'content-type': 'application/epub+zip',
      'content-disposition': `attachment; filename="${id}.epub"`,
    },
  })
}

export type AppDeps = {
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly queue?: Queue<ClipQueueMessage>
}

function storeFor(env: Cloudflare.Env, deps: AppDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  const create = deps.createStore ?? createR2Store
  return create(env)
}

function queueFor(env: Cloudflare.Env, deps: AppDeps): Queue<ClipQueueMessage> {
  return deps.queue ?? env.CLIP_QUEUE
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const clip = async (c: Context<AppEnv>) => {
    if (!(await clipTokenAuthorized(c.req.header('authorization'), c.env.CLIP_TOKEN))) {
      return unauthorizedResponse('bearer')
    }
    let raw: string
    try {
      raw = await c.req.text()
    } catch {
      return toErrorResponse({ kind: 'invalid_url', url: '' })
    }
    const shareText = parseClipShareText(c.req.header('content-type'), raw)
    if (shareText === null) {
      return toErrorResponse({ kind: 'invalid_url', url: '' })
    }

    const parsed = parseClipUrl({ url: shareText })
    if (!parsed.ok) {
      return toErrorResponse(parsed.error)
    }

    const url = parsed.value
    const jobId = await clipJobIdFromUrl(url)
    const store = storeFor(c.env, deps)
    const existing = await store.getJob(jobId)
    if (isActiveClipJob(existing, Date.now())) {
      c.header('Location', `/clip/jobs/${jobId}`)
      return c.json(toClipQueuedBody(existing), 202)
    }

    const queued: ClipQueuedJob = {
      jobId,
      runId: newClipRunId(),
      sourceUrl: url,
      status: 'queued',
      articleId: null,
      error: null,
      attempt: 0,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    }
    await store.putJob(queued)
    const started = Date.now()
    const queueLog = { jobId, runId: queued.runId, attempt: 0 }
    try {
      await queueFor(c.env, deps).send({ jobId, runId: queued.runId, url })
    } catch (cause) {
      const error = {
        kind: 'queue_failed' as const,
        reason: cause instanceof Error ? cause.message : 'queue send failed',
      }
      await store.putJob({
        ...queued,
        status: 'failed',
        error: { code: error.kind, message: errorMessage(error) },
        updatedAt: nowIso(),
      })
      logPipeline(
        { stage: 'queue', durationMs: Date.now() - started, errorKind: error.kind },
        queueLog,
      )
      return toErrorResponse(error)
    }
    logPipeline({ stage: 'queue', durationMs: Date.now() - started }, queueLog)
    c.header('Location', `/clip/jobs/${jobId}`)
    return c.json(toClipQueuedBody(queued), 202)
  }

  app.on('POST', ['/clip', '/clip/'], clip)

  const getClipJob = async (c: Context<AppEnv>) => {
    if (!(await clipTokenAuthorized(c.req.header('authorization'), c.env.CLIP_TOKEN))) {
      return unauthorizedResponse('bearer')
    }
    const jobId = c.req.param('jobId')
    if (jobId === undefined || !isClipJobId(jobId)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const job = await storeFor(c.env, deps).getJob(jobId)
    if (job === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return c.json(toClipJobBody(job), 200)
  }

  app.on('GET', ['/clip/jobs/:jobId', '/clip/jobs/:jobId/'], getClipJob)

  const uploadBook = async (c: Context<AppEnv>) => {
    if (!(await clipTokenAuthorized(c.req.header('authorization'), c.env.CLIP_TOKEN))) {
      return unauthorizedResponse('bearer')
    }
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return toErrorResponse({ kind: 'invalid_epub', reason: 'Request body must be multipart form data' })
    }
    const parsed = await parsePurchasedBookForm(form)
    if (!parsed.ok) {
      return toErrorResponse(parsed.error)
    }

    const id = await articleIdFromBytes(parsed.value.epub)
    const canonicalUrl = purchasedCanonicalUrl(id)
    await storeFor(c.env, deps).put({
      id,
      title: parsed.value.title,
      author: parsed.value.author,
      publishedAt: parsed.value.publishedAt,
      sourceUrl: canonicalUrl,
      canonicalUrl,
      language: 'ja',
      translated: false,
      epub: asEpubBytes(parsed.value.epub),
    })

    const response: PurchasedBookBody = {
      id,
      title: parsed.value.title,
      author: parsed.value.author,
      publishedAt: parsed.value.publishedAt,
      sourceUrl: canonicalUrl,
      canonicalUrl,
      language: 'ja',
      translated: false,
      status: 'ready',
      epubPath: `/${articleEpubKey(id)}`,
    }
    return c.json(response, 200)
  }

  app.on('POST', ['/books', '/books/'], uploadBook)

  const requireOpdsBasic = async (c: Context<AppEnv>) => {
    if (!(await opdsBasicAuthorized(c.req.header('authorization'), c.env.OPDS_USERNAME, c.env.OPDS_PASSWORD))) {
      return unauthorizedResponse('basic')
    }
    return null
  }

  app.get('/articles/:id', async (c) => {
    const denied = await requireOpdsBasic(c)
    if (denied !== null) {
      return denied
    }
    const id = c.req.param('id')
    if (!isArticleId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const meta = await storeFor(c.env, deps).getMeta(id)
    if (meta === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return c.json(meta, 200)
  })

  app.get('/articles/:id/book.epub', async (c) => {
    const denied = await requireOpdsBasic(c)
    if (denied !== null) {
      return denied
    }
    const id = c.req.param('id')
    if (!isArticleId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const epub = await storeFor(c.env, deps).getEpub(id)
    if (epub === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return epubFileResponse(id, epub)
  })

  const opdsCatalog = async (c: Context<AppEnv>) => {
    const denied = await requireOpdsBasic(c)
    if (denied !== null) {
      return denied
    }
    const origin = parseHttpUrl(new URL(c.req.url).origin)
    if (origin === null) {
      return toErrorResponse({ kind: 'invalid_url', url: new URL(c.req.url).origin })
    }
    const articles = await storeFor(c.env, deps).listMeta()
    const catalog = buildOpdsCatalog(articles, origin)
    return new Response(catalog.xml, {
      status: 200,
      headers: {
        'content-type': `${OPDS_CATALOG_TYPE};charset=utf-8`,
      },
    })
  }

  app.on('GET', ['/opds', '/opds/'], opdsCatalog)

  app.get('/opds/download/:file', async (c) => {
    const denied = await requireOpdsBasic(c)
    if (denied !== null) {
      return denied
    }
    const id = parseOpdsDownloadFile(c.req.param('file'))
    if (id === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const epub = await storeFor(c.env, deps).getEpub(id)
    if (epub === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return epubFileResponse(id, epub)
  })

  app.delete('/articles/:id', async (c) => {
    if (!(await clipTokenAuthorized(c.req.header('authorization'), c.env.CLIP_TOKEN))) {
      return unauthorizedResponse('bearer')
    }
    const id = c.req.param('id')
    if (!isArticleId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const deleted = await storeFor(c.env, deps).delete(id)
    if (!deleted) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return c.json({ deleted: true }, 200)
  })

  return app
}
