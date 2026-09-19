import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createExtractPipeline } from '../src/extract/pipeline'
import { createClipPipeline } from '../src/pipeline/clip'
import { createMemoryStore } from '../src/store/memory'
import { err, ok, type FetchPage } from '../src/types'
import { bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'

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
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      { ...TEST_BINDINGS, OPENAI_API_KEY: SECRET },
    )
    const text = await response.text()
    expect(response.status).toBe(503)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(TEST_CLIP_TOKEN)
    expect(text).toContain('translate_failed')
  })
})
