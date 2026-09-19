import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createExtractPipeline } from '../src/extract/pipeline'
import { createClipPipeline } from '../src/pipeline/clip'
import { createMemoryStore } from '../src/store/memory'
import { err, ok, type FetchPage } from '../src/types'
import { createFakeQueue } from './fake-queue'
import { bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'

const SECRET = 'sk-secret-must-not-leak-123'
const jaHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ja-tech.html'),
  'utf8',
)

describe('secret handling', () => {
  it('does not echo OPENAI_API_KEY in clip job JSON', async () => {
    const fetchPage: FetchPage = async (url) =>
      ok({
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/html',
        html: jaHtml,
      })
    const store = createMemoryStore()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({ fetchPage }),
      translateArticle: async (article) =>
        err({ kind: 'translate_failed', extracted: article, reason: 'OpenAI HTTP 401' }),
    })
    const app = createApp({ store, queue })
    const env = { ...TEST_BINDINGS, OPENAI_API_KEY: SECRET, CLIP_QUEUE: queue } as Cloudflare.Env
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    expect(response.status).toBe(202)
    const postText = await response.text()
    expect(postText).not.toContain(SECRET)
    expect(postText).not.toContain(TEST_CLIP_TOKEN)
    await queue.drain(env, { clipPipeline, store })
    const queued = JSON.parse(postText) as { jobId: string }
    const job = await app.request(
      `/clip/jobs/${queued.jobId}`,
      { headers: { authorization: bearerAuthorization() } },
      env,
    )
    const jobText = await job.text()
    expect(job.status).toBe(200)
    expect(jobText).toContain('translate_failed')
    expect(jobText).not.toContain(SECRET)
    expect(jobText).not.toContain(TEST_CLIP_TOKEN)
    expect(jobText).not.toContain('extracted')
    expect(jobText).not.toContain(jaHtml.slice(0, 40))
  })
})
