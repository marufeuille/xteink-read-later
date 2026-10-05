import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExtractPipeline } from '../src/extract/pipeline'
import { createClipPipeline } from '../src/pipeline/clip'
import { createClipQueueHandler } from '../src/queue/clip'
import { createMemoryStore } from '../src/store/memory'
import {
  asClipJobId,
  asClipRunId,
  ok,
  parseHttpUrl,
  type ClipQueueMessage,
} from '../src/types'
import { loggedText } from './logged-text'

afterEach(() => {
  vi.restoreAllMocks()
})

const jobId = asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const runId = asClipRunId('run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

function pipelineLogs(logs: readonly string[]): Record<string, unknown>[] {
  return logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === 'pipeline')
}

async function deliver(body: unknown): Promise<string[]> {
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(loggedText(line))
  })
  const handler = createClipQueueHandler({
    store: createMemoryStore(),
    clipPipeline: createClipPipeline({
      extractPipeline: createExtractPipeline({
        fetchPage: async (requested) =>
          ok({
            requestedUrl: requested,
            finalUrl: requested,
            contentType: 'text/html',
            html: '<!DOCTYPE html><html lang="en"><head><title>TITLE_SECRET_SHOULD_NOT_LOG</title></head><body><nav>BODY_SECRET_SHOULD_NOT_LOG</nav></body></html>',
          }),
      }),
    }),
  })
  const batch: MessageBatch<ClipQueueMessage> = {
    messages: [
      {
        id: 'msg_hostname',
        timestamp: new Date(),
        body: body as ClipQueueMessage,
        attempts: 1,
        retry() {},
        ack() {},
      },
    ],
    queue: 'xteink-read-later-clip',
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll() {},
    ackAll() {},
  }
  await handler(batch, {} as Cloudflare.Env)
  return logs
}

describe('clip failure hostname', () => {
  it('logs only the hostname when extract_failed for a URL with userinfo, port, path, query, and fragment', async () => {
    const pageUrl =
      'https://user:secret-token@News.Example.com:8443/private/article?token=query-secret#section'
    const url = parseHttpUrl(pageUrl)
    if (url === null) {
      throw new Error(pageUrl)
    }
    const logs = await deliver({ jobId, runId, url })
    const pipeline = pipelineLogs(logs)
    const terminal = pipeline.filter((entry) => entry.clipOutcome === 'failed')
    expect(terminal).toEqual([
      {
        message: 'pipeline queue failed extract_failed',
        event: 'pipeline',
        stage: 'queue',
        durationMs: expect.any(Number),
        errorKind: 'extract_failed',
        clipOutcome: 'failed',
        hostname: 'news.example.com',
        jobId,
        runId,
        attempt: 1,
      },
    ])
    expect(pipeline.some((entry) => entry.stage === 'extract' && entry.errorKind === 'extract_failed')).toBe(true)
    for (const entry of pipeline) {
      if (entry.clipOutcome !== 'failed') {
        expect(entry).not.toHaveProperty('hostname')
      }
    }
    const text = logs.join('\n')
    expect(text).toContain('"hostname":"news.example.com"')
    expect(text).not.toContain('https://')
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('query-secret')
    expect(text).not.toContain('/private/article')
    expect(text).not.toContain('8443')
    expect(text).not.toContain('#section')
    expect(text).not.toContain('TITLE_SECRET_SHOULD_NOT_LOG')
    expect(text).not.toContain('BODY_SECRET_SHOULD_NOT_LOG')
    expect(text).not.toContain('user:')
  })

  it('omits hostname and does not throw when the queue message URL cannot be parsed', async () => {
    const secretUrl = 'https://user:secret-token@news.example.com/private/article?token=query-secret#section'
    const logs = await deliver({
      jobId,
      runId,
      url: 'not a url',
      leaked: secretUrl,
    })
    expect(pipelineLogs(logs)).toEqual([
      {
        message: 'pipeline queue invalid_url',
        event: 'pipeline',
        stage: 'queue',
        durationMs: 0,
        errorKind: 'invalid_url',
      },
    ])
    const broken = await deliver(secretUrl)
    expect(pipelineLogs(broken)).toEqual([
      {
        message: 'pipeline queue invalid_url',
        event: 'pipeline',
        stage: 'queue',
        durationMs: 0,
        errorKind: 'invalid_url',
      },
    ])
    const text = `${logs.join('\n')}\n${broken.join('\n')}`
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('query-secret')
    expect(text).not.toContain('/private/article')
    expect(text).not.toContain('news.example.com')
    expect(text).not.toContain('https://')
    expect(text).not.toContain('hostname')
  })
})
