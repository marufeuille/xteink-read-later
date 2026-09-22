import { describe, expect, it } from 'vitest'
import {
  CLIP_JOB_STALE_MS,
  isActiveClipJob,
  isClipJobStale,
  shouldProcessClipRun,
} from '../src/job/clip'
import { parseClipJobRecord } from '../src/store/job'
import {
  asArticleId,
  asClipJobId,
  asClipRunId,
  parseHttpUrl,
  type ClipFailedJob,
  type ClipQueuedJob,
  type ClipReadyJob,
  type ClipRunningJob,
} from '../src/types'

function url() {
  const parsed = parseHttpUrl('https://example.com/a')
  if (parsed === null) {
    throw new Error('url')
  }
  return parsed
}

const articleId = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const jobId = asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const runA = asClipRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const runB = asClipRunId('run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

const base = {
  jobId,
  runId: runA,
  sourceUrl: url(),
  attempt: 0,
  stages: [],
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
}

function queued(overrides: Partial<Pick<ClipQueuedJob, 'runId' | 'updatedAt'>> = {}): ClipQueuedJob {
  return {
    ...base,
    status: 'queued',
    articleId: null,
    error: null,
    ...overrides,
  }
}

function running(overrides: Partial<Pick<ClipRunningJob, 'updatedAt'>> = {}): ClipRunningJob {
  return {
    ...base,
    status: 'running',
    articleId: null,
    error: null,
    ...overrides,
  }
}

function ready(): ClipReadyJob {
  return {
    ...base,
    status: 'ready',
    articleId,
    error: null,
  }
}

function failed(code: ClipFailedJob['error']['code'], message: string): ClipFailedJob {
  return {
    ...base,
    status: 'failed',
    articleId: null,
    error: { code, message },
  }
}

describe('clip job state', () => {
  it('treats queued and running jobs as stale after 15 minutes', () => {
    const now = Date.parse('2026-09-20T00:20:00.000Z')
    const fresh = running({ updatedAt: '2026-09-20T00:10:00.000Z' })
    const stale = queued({ updatedAt: '2026-09-20T00:04:59.000Z' })
    expect(now - Date.parse(fresh.updatedAt)).toBeLessThan(CLIP_JOB_STALE_MS)
    expect(isClipJobStale(fresh, now)).toBe(false)
    expect(isActiveClipJob(fresh, now)).toBe(true)
    expect(isClipJobStale(stale, now)).toBe(true)
    expect(isActiveClipJob(stale, now)).toBe(false)
    expect(isActiveClipJob(null, now)).toBe(false)
    expect(isActiveClipJob(failed('fetch_failed', 'x'), now)).toBe(false)
    expect(isClipJobStale(ready(), now)).toBe(false)
  })

  it('skips other runs, completed runs, and permanent failures', () => {
    expect(shouldProcessClipRun(null, runA)).toBe(true)
    expect(shouldProcessClipRun(queued(), runA)).toBe(true)
    expect(shouldProcessClipRun(running(), runA)).toBe(true)
    expect(shouldProcessClipRun(queued({ runId: runB }), runA)).toBe(false)
    expect(shouldProcessClipRun(ready(), runA)).toBe(false)
    expect(shouldProcessClipRun(failed('extract_failed', 'no article'), runA)).toBe(false)
    expect(shouldProcessClipRun(failed('queue_failed', 'send'), runA)).toBe(true)
  })

  it('requires runId on stored job records', () => {
    const valid = queued()
    expect(parseClipJobRecord(valid)).toEqual(valid)
    expect(parseClipJobRecord({ ...valid, runId: 'run_not_valid' })).toBeNull()
    expect(parseClipJobRecord({ ...valid, runId: undefined })).toBeNull()
  })

  it('reads jobs saved before stages existed as an empty stage list', () => {
    const { stages, ...legacy } = queued()
    expect(stages).toEqual([])
    expect(parseClipJobRecord(legacy)).toEqual(queued())
    expect(
      parseClipJobRecord({
        ...queued(),
        stages: [
          { stage: 'fetch', durationMs: 12, attempt: 1, errorKind: 'fetch_failed' },
          { stage: 'nope', durationMs: 1, attempt: 1 },
          { stage: 'extract', durationMs: -1, attempt: 1 },
        ],
      })?.stages,
    ).toEqual([{ stage: 'fetch', durationMs: 12, attempt: 1, errorKind: 'fetch_failed' }])
  })
})
