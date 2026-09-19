import { Hono } from 'hono'
import { parseClipUrl } from './extract/parse-clip-url'
import { isClipRequestBody } from './http/clip-request'
import { toErrorResponse } from './http/error-response'
import { buildOpdsCatalog, OPDS_CATALOG_TYPE, parseOpdsDownloadFile } from './opds/catalog'
import { createR2Store } from './store/r2'
import type { AppEnv, ArticleId, ArticleStore, ClipPipeline, ClipReadyBody, CreateArticleStore, EpubBytes } from './types'
import { articleEpubKey, isArticleId, parseHttpUrl } from './types'

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

  app.post('/clip', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return toErrorResponse({ kind: 'invalid_url', url: '' })
    }
    if (!isClipRequestBody(body)) {
      const url =
        typeof body === 'object' && body !== null && 'url' in body
          ? String(body.url)
          : ''
      return toErrorResponse({ kind: 'invalid_url', url })
    }

    const parsed = parseClipUrl(body)
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
  })

  app.get('/articles/:id', async (c) => {
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

  app.get('/opds', async (c) => {
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
  })

  app.get('/opds/download/:file', async (c) => {
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
