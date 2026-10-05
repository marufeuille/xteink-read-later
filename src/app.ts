import { Hono, type Context } from 'hono'
import { forbiddenResponse, resolveClipPrincipal, resolveOpdsPrincipal, unauthorizedResponse } from './http/auth'
import { articleMatchesSmokeUrl, configuredSmokeArticleUrl, httpUrlsEqual } from './http/smoke-scope'
import { mountBookRoutes } from './http/book-routes'
import { mountCandidateRoutes, type CandidateHttpDeps } from './http/candidate-routes'
import { mountClipRecentRoutes } from './http/clip-recent-routes'
import { mountClipWebRoutes } from './http/clip-web-routes'
import { mountDigestConfirmRoutes } from './http/digest-confirm-routes'
import { mountDigestRoutes, type DigestHttpDeps } from './http/digest-routes'
import { mountSourceRoutes, type SourceHttpDeps } from './http/source-routes'
import { toClipJobBody, toClipQueuedBody } from './http/clip-job'
import { parseClipUrl } from './extract/parse-clip-url'
import { parseClipShareText } from './http/clip-request'
import { toErrorResponse } from './http/error-response'
import { enqueueClipJob } from './job/enqueue'
import { logOpdsDownload } from './log'
import {
  buildOpdsCatalog,
  OPDS_CACHE_CONTROL,
  opdsCatalogContentType,
  parseOpdsCatalogPath,
  parseOpdsDownloadFile,
} from './opds/catalog'
import { createR2Store } from './store/r2'
import type {
  AppEnv,
  ArticleId,
  ArticleStore,
  ClipQueueMessage,
  CreateArticleStore,
  EpubBytes,
  FeedQueueMessage,
  DigestQueueMessage,
} from './types'
import {
  articleEpubKey,
  isArticleId,
  isClipJobId,
  parseHttpUrl,
} from './types'

function epubFileResponse(id: ArticleId, epub: EpubBytes): Response {
  return new Response(epub, {
    status: 200,
    headers: {
      'content-type': 'application/epub+zip',
      'content-disposition': `attachment; filename="${id}.epub"`,
      'cache-control': OPDS_CACHE_CONTROL,
    },
  })
}

export type AppDeps = {
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly queue?: Queue<ClipQueueMessage>
  readonly feedQueue?: Queue<FeedQueueMessage>
  readonly digestQueue?: Queue<DigestQueueMessage>
} & CandidateHttpDeps &
  SourceHttpDeps &
  DigestHttpDeps

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

function smokeArticleUrl(env: Cloudflare.Env): string | undefined {
  return typeof env.SMOKE_ARTICLE_URL === 'string' ? env.SMOKE_ARTICLE_URL : undefined
}

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const clip = async (c: Context<AppEnv>) => {
    const principal = await resolveClipPrincipal(
      c.req.header('authorization'),
      c.env.CLIP_TOKEN,
      c.env.SMOKE_CLIP_TOKEN_SHA256,
    )
    if (principal === null) {
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
    if (principal === 'smoke') {
      const allowed = configuredSmokeArticleUrl(smokeArticleUrl(c.env))
      if (allowed === null || !httpUrlsEqual(url, allowed)) {
        return forbiddenResponse()
      }
    }
    const queued = await enqueueClipJob({
      store: storeFor(c.env, deps),
      queue: queueFor(c.env, deps),
      url,
      nowMs: Date.now(),
      reuseReady: false,
    })
    if (!queued.ok) {
      return toErrorResponse(queued.error)
    }
    c.header('Location', `/clip/jobs/${queued.job.jobId}`)
    return c.json(toClipQueuedBody(queued.job), 202)
  }

  app.on('POST', ['/clip', '/clip/'], clip)
  mountClipWebRoutes(app, deps)
  mountClipRecentRoutes(app, deps)

  const getClipJob = async (c: Context<AppEnv>) => {
    const principal = await resolveClipPrincipal(
      c.req.header('authorization'),
      c.env.CLIP_TOKEN,
      c.env.SMOKE_CLIP_TOKEN_SHA256,
    )
    if (principal === null) {
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
    if (principal === 'smoke') {
      const allowed = configuredSmokeArticleUrl(smokeArticleUrl(c.env))
      if (allowed === null || !httpUrlsEqual(job.sourceUrl, allowed)) {
        return toErrorResponse({ kind: 'not_found' })
      }
    }
    return c.json(toClipJobBody(job), 200)
  }

  app.on('GET', ['/clip/jobs/:jobId', '/clip/jobs/:jobId/'], getClipJob)
  mountBookRoutes(app, deps)

  const opdsPrincipal = async (c: Context<AppEnv>) => {
    const principal = await resolveOpdsPrincipal(
      c.req.header('authorization'),
      c.env.OPDS_USERNAME,
      c.env.OPDS_PASSWORD,
      c.env.SMOKE_OPDS_BASIC_SHA256,
    )
    if (principal === null) {
      return unauthorizedResponse('basic')
    }
    return principal
  }

  const smokeMayReadArticle = async (c: Context<AppEnv>, id: ArticleId): Promise<boolean> => {
    const meta = await storeFor(c.env, deps).getMeta(id)
    return meta !== null && articleMatchesSmokeUrl(meta, smokeArticleUrl(c.env))
  }

  app.get('/articles/:id', async (c) => {
    const principal = await opdsPrincipal(c)
    if (principal instanceof Response) {
      return principal
    }
    const id = c.req.param('id')
    if (!isArticleId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const meta = await storeFor(c.env, deps).getMeta(id)
    if (meta === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    if (principal === 'smoke' && !articleMatchesSmokeUrl(meta, smokeArticleUrl(c.env))) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return c.json(meta, 200)
  })

  app.get('/articles/:id/book.epub', async (c) => {
    const principal = await opdsPrincipal(c)
    if (principal instanceof Response) {
      return principal
    }
    const id = c.req.param('id')
    if (!isArticleId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    if (principal === 'smoke' && !(await smokeMayReadArticle(c, id))) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const started = Date.now()
    const epub = await storeFor(c.env, deps).getEpub(id)
    if (epub === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    logOpdsDownload({ articleId: id, durationMs: Date.now() - started })
    return epubFileResponse(id, epub)
  })

  const opdsCatalog = async (c: Context<AppEnv>) => {
    const principal = await opdsPrincipal(c)
    if (principal instanceof Response) {
      return principal
    }
    const requestUrl = new URL(c.req.url)
    const location = parseOpdsCatalogPath(requestUrl.pathname)
    if (location === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const origin = parseHttpUrl(requestUrl.origin)
    if (origin === null) {
      return toErrorResponse({ kind: 'invalid_url', url: requestUrl.origin })
    }
    const listed = await storeFor(c.env, deps).listMeta()
    const articles =
      principal === 'smoke'
        ? listed.filter((article) => articleMatchesSmokeUrl(article, smokeArticleUrl(c.env)))
        : listed
    const catalog = buildOpdsCatalog(articles, origin, location)
    if (catalog === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return new Response(catalog.xml, {
      status: 200,
      headers: {
        'content-type': opdsCatalogContentType(catalog.feedKind),
        'cache-control': OPDS_CACHE_CONTROL,
      },
    })
  }

  app.on(
    'GET',
    [
      '/opds',
      '/opds/',
      '/opds/clip',
      '/opds/clip/',
      '/opds/ebook',
      '/opds/ebook/',
      '/opds/clip/:date',
      '/opds/clip/:date/',
      '/opds/ebook/:date',
      '/opds/ebook/:date/',
    ],
    opdsCatalog,
  )

  app.get('/opds/download/:file', async (c) => {
    const principal = await opdsPrincipal(c)
    if (principal instanceof Response) {
      return principal
    }
    const id = parseOpdsDownloadFile(c.req.param('file'))
    if (id === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    if (principal === 'smoke' && !(await smokeMayReadArticle(c, id))) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const started = Date.now()
    const epub = await storeFor(c.env, deps).getEpub(id)
    if (epub === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    logOpdsDownload({ articleId: id, durationMs: Date.now() - started })
    return epubFileResponse(id, epub)
  })

  app.delete('/articles/:id', async (c) => {
    const principal = await resolveClipPrincipal(
      c.req.header('authorization'),
      c.env.CLIP_TOKEN,
      c.env.SMOKE_CLIP_TOKEN_SHA256,
    )
    if (principal === null) {
      return unauthorizedResponse('bearer')
    }
    const id = c.req.param('id')
    if (!isArticleId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    if (principal === 'smoke' && !(await smokeMayReadArticle(c, id))) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const deleted = await storeFor(c.env, deps).delete(id)
    if (!deleted) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return c.json({ deleted: true }, 200)
  })

  mountCandidateRoutes(app, deps)
  mountSourceRoutes(app, deps)
  mountDigestRoutes(app, deps)
  mountDigestConfirmRoutes(app, deps)

  return app
}
