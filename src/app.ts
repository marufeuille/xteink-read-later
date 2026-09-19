import { Hono } from 'hono'
import { parseClipUrl } from './extract/parse-clip-url'
import { isClipRequestBody } from './http/clip-request'
import { toErrorResponse } from './http/error-response'
import type { AppEnv, ArticleStore, ClipPipeline, ClipReadyBody } from './types'
import { articleEpubKey, isArticleId } from './types'

export type AppDeps = {
  readonly clipPipeline: ClipPipeline
  readonly store: ArticleStore
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

    const { id, article, epub, timingsMs } = result.value
    await deps.store.put({
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
    const meta = await deps.store.getMeta(id)
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
    const epub = await deps.store.getEpub(id)
    if (epub === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    return new Response(epub, {
      status: 200,
      headers: {
        'content-type': 'application/epub+zip',
        'content-disposition': `attachment; filename="${id}.epub"`,
      },
    })
  })

  return app
}
