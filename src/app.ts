import { Hono, type Context } from 'hono'
import { clipTokenAuthorized, opdsBasicAuthorized, unauthorizedResponse } from './http/auth'
import { parseClipUrl } from './extract/parse-clip-url'
import { parseClipShareText } from './http/clip-request'
import { toErrorResponse } from './http/error-response'
import { parsePurchasedBookForm } from './http/purchased-book'
import { buildOpdsCatalog, OPDS_CATALOG_TYPE, parseOpdsDownloadFile } from './opds/catalog'
import { createR2Store } from './store/r2'
import type { AppEnv, ArticleId, ArticleStore, ClipPipeline, ClipReadyBody, CreateArticleStore, EpubBytes, PurchasedBookBody } from './types'
import { articleEpubKey, articleIdFromBytes, asEpubBytes, isArticleId, parseHttpUrl, purchasedCanonicalUrl } from './types'

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
  readonly clipPipeline: ClipPipeline
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
}

function storeFor(env: Cloudflare.Env, deps: AppDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  const create = deps.createStore ?? createR2Store
  return create(env)
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
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

    const result = await deps.clipPipeline(parsed.value, {
      OPENAI_API_KEY: c.env.OPENAI_API_KEY,
    })
    if (!result.ok) {
      return toErrorResponse(result.error)
    }

    const store = storeFor(c.env, deps)
    const { id, article, epub, timingsMs } = result.value
    await store.put({
      id,
      title: article.title,
      author: article.author,
      publishedAt: article.publishedAt,
      sourceUrl: article.sourceUrl,
      canonicalUrl: article.canonicalUrl,
      language: article.language,
      translated: article.translated,
      epub,
    })

    const response: ClipReadyBody = {
      id,
      title: article.title,
      author: article.author,
      publishedAt: article.publishedAt,
      sourceUrl: article.sourceUrl,
      canonicalUrl: article.canonicalUrl,
      language: article.language,
      translated: article.translated,
      status: 'ready',
      epubPath: `/${articleEpubKey(id)}`,
      timingsMs,
    }
    return c.json(response, 200)
  }

  app.on('POST', ['/clip', '/clip/'], clip)

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
