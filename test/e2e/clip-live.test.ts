import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createClipPipeline } from '../../src/pipeline/clip'
import { createMemoryStore } from '../../src/store/memory'

const live = process.env.E2E_LIVE === '1'

type ClipJson = {
  status?: string
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
      const env = { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' } as Cloudflare.Env
      const app = createApp({
        clipPipeline: createClipPipeline(),
        store: createMemoryStore(),
      })
      const response = await app.request(
        '/clip',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
        },
        env,
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as ClipJson
      expect(body.status).toBe('ready')
      expect(body.epubPath).toMatch(/^\/articles\/art_[a-f0-9]{32}\/book\.epub$/)

      const epubResponse = await app.request(body.epubPath ?? '', {}, env)
      expect(epubResponse.status).toBe(200)
      const files = unzipSync(new Uint8Array(await epubResponse.arrayBuffer()))
      expect(strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())).toContain(
        '<package',
      )
    },
    120_000,
  )
})
