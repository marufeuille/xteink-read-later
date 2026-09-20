import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExtractPipeline } from '../src/extract/pipeline'
import { pipelineLogFields } from '../src/log'
import { createClipPipeline } from '../src/pipeline/clip'
import {
  asClipJobId,
  asClipRunId,
  err,
  ok,
  parseHttpUrl,
  type FetchPage,
} from '../src/types'

afterEach(() => {
  vi.restoreAllMocks()
})

const jobId = asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const runId = asClipRunId('run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const jaHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ja-tech.html'),
  'utf8',
)

function url() {
  const parsed = parseHttpUrl('https://example.com/ja/log')
  if (parsed === null) {
    throw new Error('url')
  }
  return parsed
}

describe('pipeline log context', () => {
  it('omits undefined optional fields', () => {
    expect(pipelineLogFields(undefined)).toEqual({})
    expect(pipelineLogFields({ jobId })).toEqual({ jobId })
    expect(pipelineLogFields({ jobId, runId, attempt: 0 })).toEqual({ jobId, runId, attempt: 0 })
  })

  it('attaches jobId to fetch and extract logs', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchPage: FetchPage = async (requested) =>
      ok({
        requestedUrl: requested,
        finalUrl: requested,
        contentType: 'text/html',
        html: jaHtml,
      })
    await createExtractPipeline({ fetchPage })(url(), { jobId, runId, attempt: 1 })
    const events = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(events.map((item) => item.stage)).toEqual(['fetch', 'extract'])
    for (const event of events) {
      expect(event).toMatchObject({ event: 'pipeline', jobId, runId, attempt: 1 })
      expect(event).not.toHaveProperty('url')
      expect(JSON.stringify(event)).not.toContain('npx wrangler dev')
    }
  })

  it('attaches jobId to translate failure logs', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchPage: FetchPage = async (requested) =>
      ok({
        requestedUrl: requested,
        finalUrl: requested,
        contentType: 'text/html',
        html: jaHtml,
      })
    const pipeline = createClipPipeline({
      extractPipeline: createExtractPipeline({ fetchPage }),
      translateArticle: async (article) =>
        err({ kind: 'translate_failed', extracted: article, reason: 'OpenAI HTTP 401' }),
    })
    await pipeline(url(), { OPENAI_API_KEY: 'sk-secret-must-not-leak' }, { jobId, attempt: 2 })
    const events = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    const translate = events.find((item) => item.stage === 'translate')
    expect(translate).toMatchObject({
      event: 'pipeline',
      jobId,
      attempt: 2,
      stage: 'translate',
      errorKind: 'translate_failed',
    })
    expect(JSON.stringify(translate)).not.toContain('sk-secret-must-not-leak')
    expect(JSON.stringify(translate)).not.toContain('extracted')
    expect(JSON.stringify(translate)).not.toContain('npx wrangler dev')
  })
})
