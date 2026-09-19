import { Hono } from 'hono'
import { parseClipUrl } from './extract/parse-clip-url'
import { isClipRequestBody } from './http/clip-request'
import { toErrorResponse } from './http/error-response'
import type { AppEnv, ClipTranslatedBody } from './types'
import type { TranslatePipeline } from './translate/pipeline'

export type AppDeps = {
  readonly translatePipeline: TranslatePipeline
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

    const result = await deps.translatePipeline(parsed.value, {
      OPENAI_API_KEY: c.env.OPENAI_API_KEY,
    })
    if (!result.ok) {
      return toErrorResponse(result.error)
    }

    const { id, article, timingsMs } = result.value
    const response: ClipTranslatedBody = {
      id,
      ...article,
      timingsMs,
    }
    return c.json(response, 200)
  })

  return app
}
