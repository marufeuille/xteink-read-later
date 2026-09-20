import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createClipPipeline } from '../../src/pipeline/clip'
import { createMemoryStore } from '../../src/store/memory'
import { basicAuthorization, bearerAuthorization, TEST_BINDINGS } from '../bindings'
import { createFakeQueue } from '../fake-queue'

const live = process.env.E2E_LIVE === '1'

type ClipJson = {
  status?: string
  jobId?: string
  epubPath?: string
  error?: { code: string }
}

describe.skipIf(!live)('live clip E2E', () => {
  it(
    'clips E2E_LIVE_URL through the real network pipeline',
    async () => {
      const url = process.env.E2E_LIVE_URL
      if (url === undefined || url.trim().length === 0) {
        throw new Error('E2E_LIVE=1 requires E2E_LIVE_URL')
      }
      const clipToken = process.env.CLIP_TOKEN ?? ''
      if (clipToken.length === 0) {
        throw new Error('E2E_LIVE=1 requires CLIP_TOKEN')
      }
      const store = createMemoryStore()
      const queue = createFakeQueue()
      const clipPipeline = createClipPipeline()
      const env = {
        ...TEST_BINDINGS,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
        CLIP_TOKEN: clipToken,
        CLIP_QUEUE: queue,
      } as Cloudflare.Env
      const app = createApp({
        store,
        queue,
      })
      const response = await app.request(
        '/clip',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: bearerAuthorization(clipToken),
          },
          body: JSON.stringify({ url }),
        },
        env,
      )
      expect(response.status).toBe(202)
      await queue.drain(env, { clipPipeline, store })
      const queued = (await response.json()) as ClipJson
      expect(queued.status).toBe('queued')
      const jobResponse = await app.request(
        `/clip/jobs/${queued.jobId}`,
        { headers: { authorization: bearerAuthorization(clipToken) } },
        env,
      )
      const job = (await jobResponse.json()) as ClipJson
      expect(job.status).toBe('ready')
      expect(job.epubPath).toMatch(/^\/articles\/art_[a-f0-9]{32}\/book\.epub$/)

      const epubResponse = await app.request(
        job.epubPath ?? '',
        { headers: { authorization: basicAuthorization() } },
        env,
      )
      expect(epubResponse.status).toBe(200)
      const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
      expect(strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())).toContain(
        '<package',
      )
    },
    120_000,
  )
})
