import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createExtractPipeline } from '../src/extract/pipeline'
import { createClipPipeline } from '../src/pipeline/clip'
import { createMemoryStore } from '../src/store/memory'
import { err, ok, type FetchPage } from '../src/types'

const SECRET = 'sk-secret-must-not-leak-123'
const jaHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ja-tech.html'),
  'utf8',
)

describe('secret handling', () => {
  it('does not echo OPENAI_API_KEY in clip error JSON', async () => {
    const fetchPage: FetchPage = async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: jaHtml,
      })
    const app = createApp({
      clipPipeline: createClipPipeline({
        extractPipeline: createExtractPipeline({ fetchPage }),
        translateArticle: async (article) =>
          err({ kind: 'translate_failed', extracted: article, reason: 'OpenAI HTTP 401' }),
      }),
      store: createMemoryStore(),
    })
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      { OPENAI_API_KEY: SECRET } as Cloudflare.Env,
    )
    const text = await response.text()
    expect(response.status).toBe(503)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('translate_failed')
  })
})
