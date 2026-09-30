import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { CLIP_QUEUE_MAX_RETRIES } from '../src/queue/clip'
import { createMemoryStore } from '../src/store/memory'
import { clipJobIdFromUrl, parseHttpUrl } from '../src/types'
import { bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'
import { createFakeQueue } from './fake-queue'
import { loggedText } from './logged-text'

afterEach(() => {
  vi.restoreAllMocks()
})

function pipelineLogs(logs: readonly string[]): Record<string, unknown>[] {
  return logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === 'pipeline')
}

describe('clip outcome logs', () => {
  it('marks only the final unexpected error as clip failed', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(loggedText(line))
    })
    const store = createMemoryStore()
    const queue = createFakeQueue()
    const app = createApp({ store, queue })
    const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
    const pageUrl = 'https://example.com/boom'
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: pageUrl }),
      },
      env,
    )
    expect(response.status).toBe(202)
    await queue.drain(env, {
      store,
      clipPipeline: async () => {
        throw new Error('boom secret https://example.com/boom')
      },
    })

    const internal = pipelineLogs(logs).filter((entry) => entry.errorKind === 'internal_error')
    const terminal = internal.filter((entry) => entry.clipOutcome === 'failed')
    expect(internal).toHaveLength(CLIP_QUEUE_MAX_RETRIES + 1)
    expect(terminal).toEqual([
      expect.objectContaining({
        event: 'pipeline',
        stage: 'queue',
        errorKind: 'internal_error',
        clipOutcome: 'failed',
        attempt: CLIP_QUEUE_MAX_RETRIES + 1,
        message: 'pipeline queue failed internal_error',
      }),
    ])
    expect(internal.filter((entry) => entry.clipOutcome === undefined)).toHaveLength(CLIP_QUEUE_MAX_RETRIES)
    const text = JSON.stringify(internal)
    expect(text).not.toContain('boom secret')
    expect(text).not.toContain('https://')
    expect(text).not.toContain(TEST_CLIP_TOKEN)

    const url = parseHttpUrl(pageUrl)
    if (url === null) {
      throw new Error(pageUrl)
    }
    const job = await store.getJob(await clipJobIdFromUrl(url))
    expect(job?.status).toBe('failed')
    expect(job?.error?.code).toBe('internal_error')
    expect(JSON.stringify(job?.stages)).not.toContain('clipOutcome')
  })
})
