import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createMemoryStore } from '../../src/store/memory'
import { accessIdentity, bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from '../bindings'
import { createFakeQueue } from '../fake-queue'
import { installNetworkMock } from './mock-network'

const ARTICLE_URL = 'https://example.com/articles/pc-clip?ref=tab'

function app() {
  const store = createMemoryStore()
  const queue = createFakeQueue()
  const hono = createApp({ store, queue, ...accessIdentity() })
  const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
  return { hono, queue, env }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clip web fixture e2e', () => {
  it('confirms the open tab, then queues it once', async () => {
    const network = installNetworkMock({ pages: {} })
    const ctx = app()
    const opened = await ctx.hono.request(
      `https://read.example/clip/web?url=${encodeURIComponent(ARTICLE_URL)}`,
      {},
      ctx.env,
    )
    expect(opened.status).toBe(200)
    const html = await opened.text()
    expect(html).toContain('クリップする')
    expect(html).toContain(ARTICLE_URL)
    expect(html).not.toContain(TEST_CLIP_TOKEN)
    expect(ctx.queue.size).toBe(0)
    expect(network.fetchedUrls).toEqual([])

    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
    const submit = await ctx.hono.request(
      'https://read.example/clip/web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, url: ARTICLE_URL }).toString(),
      },
      ctx.env,
    )
    expect(submit.status).toBe(202)
    const accepted = await submit.text()
    const jobId = /jobId: (job_[a-f0-9]{32})/.exec(accepted)?.[1]
    expect(accepted).toContain('status: queued')
    expect(jobId).toMatch(/^job_/)
    expect(ctx.queue.size).toBe(1)
    expect(network.fetchedUrls).toEqual([])

    const duplicate = await ctx.hono.request(
      'https://read.example/clip/web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, url: ARTICLE_URL }).toString(),
      },
      ctx.env,
    )
    expect(duplicate.status).toBe(202)
    expect(await duplicate.text()).toContain(jobId ?? '')
    expect(ctx.queue.size).toBe(1)

    const api = await ctx.hono.request(
      'https://read.example/clip/web',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({ url: 'https://example.com/articles/other' }),
      },
      ctx.env,
    )
    expect(api.status).toBe(202)
    expect(await api.json()).toMatchObject({
      status: 'queued',
      sourceUrl: 'https://example.com/articles/other',
    })
    expect(ctx.queue.size).toBe(2)
    expect(network.fetchedUrls).toEqual([])
  })
})
