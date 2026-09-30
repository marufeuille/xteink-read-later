import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { RECENT_CLIP_LIMIT, toRecentClip } from '../src/clip/recent'
import { createMemoryStore } from '../src/store/memory'
import { createR2Store } from '../src/store/r2'
import {
  asArticleId,
  asClipJobId,
  asClipRunId,
  clipJobKey,
  parseHttpUrl,
  type ClipJobRecord,
  type ClipJobStatus,
  type PipelineStage,
} from '../src/types'
import { accessIdentity, bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'
import { createFakeR2Bucket } from './fake-r2'
import { loggedText } from './logged-text'

const SECRET_URL = `https://secret.example/articles/${TEST_CLIP_TOKEN}`
const SECRET_MESSAGE = `leak ${TEST_CLIP_TOKEN} full body`
const SECRET_TITLE = 'SECRET_TITLE_XYZ'
const SECRET_BODY = '<p>SECRET_BODY_XYZ</p>'

function url(value: string) {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function jobId(n: number) {
  return asClipJobId(`job_${n.toString(16).padStart(32, '0')}`)
}

function runId(n: number) {
  return asClipRunId(`run_${n.toString(16).padStart(32, '0')}`)
}

function stamp(index: number): string {
  return new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString()
}

function job(input: {
  readonly n: number
  readonly status: ClipJobStatus
  readonly stage?: PipelineStage
  readonly updatedAt?: string
  readonly sourceUrl?: string
  readonly message?: string
}): ClipJobRecord {
  const updatedAt = input.updatedAt ?? stamp(input.n)
  const stages =
    input.stage === undefined
      ? []
      : [{ stage: input.stage, durationMs: 10, attempt: 0 }]
  const base = {
    jobId: jobId(input.n),
    runId: runId(input.n),
    sourceUrl: url(input.sourceUrl ?? `https://secret.example/n/${String(input.n)}`),
    attempt: 1,
    stages,
    createdAt: stamp(0),
    updatedAt,
  }
  if (input.status === 'ready') {
    return {
      ...base,
      status: 'ready',
      articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      error: null,
    }
  }
  if (input.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      articleId: null,
      error: { code: 'fetch_failed', message: input.message ?? SECRET_MESSAGE },
    }
  }
  return {
    ...base,
    status: input.status,
    articleId: null,
    error: null,
  }
}

function appWith(store = createMemoryStore(), access = true) {
  const app = createApp({
    store,
    ...(access ? accessIdentity() : {}),
  })
  return { app, store, env: TEST_BINDINGS }
}

describe('toRecentClip', () => {
  it('keeps jobId, status, the latest stage, and error.code', () => {
    const failed = job({
      n: 1,
      status: 'failed',
      stage: 'extract',
      sourceUrl: SECRET_URL,
      message: SECRET_MESSAGE,
    })
    const withLaterStage: ClipJobRecord = {
      ...failed,
      stages: [
        { stage: 'fetch', durationMs: 5, attempt: 0, errorKind: 'fetch_failed' },
        { stage: 'extract', durationMs: 8, attempt: 1 },
      ],
    }
    expect(toRecentClip(withLaterStage)).toEqual({
      jobId: jobId(1),
      status: 'failed',
      stage: 'extract',
      error: { code: 'fetch_failed' },
    })
    expect(JSON.stringify(toRecentClip(withLaterStage))).not.toContain(SECRET_URL)
    expect(JSON.stringify(toRecentClip(withLaterStage))).not.toContain(SECRET_MESSAGE)
    expect(JSON.stringify(toRecentClip(withLaterStage))).not.toContain(TEST_CLIP_TOKEN)
    expect(toRecentClip(job({ n: 2, status: 'queued' }))).toEqual({
      jobId: jobId(2),
      status: 'queued',
      stage: null,
    })
    expect(toRecentClip(job({ n: 3, status: 'ready', stage: 'classify' })).error).toBeUndefined()
  })
})

describe('GET /clip/recent', () => {
  it('requires Access for HTML and does not echo the token', async () => {
    const { app, env } = appWith(createMemoryStore(), false)
    const response = await app.request('/clip/recent', {}, env)
    expect(response.status).toBe(401)
    const html = await response.text()
    expect(html).toContain('Google アカウントで入る')
    expect(html).not.toContain(TEST_CLIP_TOKEN)
  })

  it('requires Bearer for JSON when Access did not run', async () => {
    const { app, env } = appWith(createMemoryStore(), false)
    const response = await app.request(
      '/clip/recent/',
      { headers: { accept: 'application/json' } },
      env,
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(await response.text()).not.toContain(TEST_CLIP_TOKEN)
  })

  it('shows an empty list and a refresh link', async () => {
    const { app, env } = appWith()
    const response = await app.request('/clip/recent/', {}, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('最近のクリップはまだありません')
    expect(html).toContain('ポーリングしなくても')
    expect(html).toContain('href="/clip/recent"')
    expect(html).not.toContain('class="clip-failed"')
    expect(html).not.toContain('class="fail-banner"')
    expect(html).not.toContain(TEST_CLIP_TOKEN)
  })

  it('lists only safe fields, newest first, and makes failures stand out', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(loggedText(line))
    })
    try {
      const { app, store, env } = appWith()
      const failed = job({
        n: 1,
        status: 'failed',
        stage: 'fetch',
        updatedAt: stamp(1),
        sourceUrl: SECRET_URL,
        message: SECRET_MESSAGE,
      })
      const ready = job({ n: 2, status: 'ready', stage: 'store', updatedAt: stamp(2) })
      const running = job({ n: 3, status: 'running', stage: 'translate', updatedAt: stamp(3) })
      await store.putJob(failed)
      await store.putJob(ready)
      await store.putJob(running)

      const response = await app.request('/clip/recent', {}, env)
      expect(response.status).toBe(200)
      const html = await response.text()
      const runningAt = html.indexOf(running.jobId)
      const readyAt = html.indexOf(ready.jobId)
      const failedAt = html.indexOf(failed.jobId)
      expect(runningAt).toBeGreaterThan(-1)
      expect(runningAt).toBeLessThan(readyAt)
      expect(readyAt).toBeLessThan(failedAt)
      const block = (id: string) => {
        const at = html.indexOf(`jobId: ${id}`)
        const start = html.lastIndexOf('<article', at)
        const end = html.indexOf('</article>', at)
        return html.slice(start, end)
      }
      expect(html).toContain('class="fail-banner"')
      expect(html).toContain('失敗が 1 件あります')
      expect(block(running.jobId)).not.toContain('clip-failed')
      expect(block(running.jobId)).not.toContain('失敗')
      expect(block(ready.jobId)).not.toContain('clip-failed')
      expect(block(ready.jobId)).not.toContain('失敗')
      const failedBlock = block(failed.jobId)
      expect(failedBlock).toContain('class="clip-failed"')
      expect(failedBlock).toContain('role="alert"')
      expect(failedBlock).toContain('失敗')
      expect(failedBlock).toContain('status: failed')
      expect(failedBlock).toContain('stage: fetch')
      expect(failedBlock).toContain('error.code: fetch_failed')
      expect(html).toContain('status: running')
      expect(html).toContain('stage: translate')
      expect(html).toContain('status: ready')
      expect(html).not.toContain('secret.example')
      expect(html).not.toContain(SECRET_MESSAGE)
      expect(html).not.toContain(TEST_CLIP_TOKEN)
      expect(html).not.toContain('error.message')
      expect(html).not.toContain(ready.articleId ?? '')
      expect(logs.join('\n')).not.toContain(SECRET_URL)
      expect(logs.join('\n')).not.toContain(TEST_CLIP_TOKEN)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('returns the same safe JSON for Bearer without article fields', async () => {
    const { app, store, env } = appWith(createMemoryStore(), false)
    await store.putJob(
      job({
        n: 4,
        status: 'failed',
        stage: 'epub',
        updatedAt: stamp(1),
        sourceUrl: SECRET_URL,
        message: SECRET_MESSAGE,
      }),
    )
    await store.putJob(job({ n: 5, status: 'queued', updatedAt: stamp(2) }))
    const response = await app.request(
      '/clip/recent',
      {
        headers: {
          accept: 'application/json',
          authorization: bearerAuthorization(),
        },
      },
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(body).toEqual({
      jobs: [
        { jobId: jobId(5), status: 'queued', stage: null },
        {
          jobId: jobId(4),
          status: 'failed',
          stage: 'epub',
          error: { code: 'fetch_failed' },
        },
      ],
    })
    const text = JSON.stringify(body)
    expect(text).not.toContain('secret.example')
    expect(text).not.toContain(SECRET_MESSAGE)
    expect(text).not.toContain(TEST_CLIP_TOKEN)
    expect(text).not.toContain('sourceUrl')
    if (typeof body !== 'object' || body === null || !('jobs' in body) || !Array.isArray(body.jobs)) {
      throw new Error('jobs')
    }
    expect(Object.keys(body.jobs[0] ?? {}).sort()).toEqual(['jobId', 'stage', 'status'])
    expect(Object.keys(body.jobs[1] ?? {}).sort()).toEqual(['error', 'jobId', 'stage', 'status'])
    const error = (body.jobs[1] as { error?: unknown }).error
    expect(Object.keys(error ?? {}).sort()).toEqual(['code'])
  })

  it('keeps only the newest jobs', async () => {
    const { app, store, env } = appWith()
    for (let n = 1; n <= RECENT_CLIP_LIMIT + 1; n += 1) {
      await store.putJob(job({ n, status: 'queued', stage: 'queue', updatedAt: stamp(n) }))
    }
    const response = await app.request('/clip/recent', {}, env)
    const html = await response.text()
    const ids = [...html.matchAll(/jobId: (job_[a-f0-9]{32})/g)].map((match) => match[1])
    expect(ids).toHaveLength(RECENT_CLIP_LIMIT)
    expect(ids[0]).toBe(jobId(RECENT_CLIP_LIMIT + 1))
    expect(ids).not.toContain(jobId(1))
  })

  it('does not list checkpoint bodies from R2', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const hidden = job({
      n: 7,
      status: 'failed',
      stage: 'fetch',
      updatedAt: stamp(1),
      sourceUrl: SECRET_URL,
      message: SECRET_MESSAGE,
    })
    const newer = job({ n: 8, status: 'ready', stage: 'classify', updatedAt: stamp(9) })
    const olderWrite = job({ n: 9, status: 'running', stage: 'queue', updatedAt: stamp(4) })
    await store.putJob(olderWrite)
    await store.putJob(hidden)
    await store.putJob(newer)
    await store.putClipCheckpoint({
      jobId: jobId(7),
      runId: runId(7),
      articleId: asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      article: {
        title: SECRET_TITLE,
        author: null,
        publishedAt: null,
        sourceUrl: url(SECRET_URL),
        canonicalUrl: url('https://secret.example/canonical'),
        contentHtml: SECRET_BODY,
        language: 'ja',
        translated: true,
      },
    })
    await bucket.put(clipJobKey(jobId(10)), '{')
    await bucket.put('jobs/not-a-job.json', '{"title":"SECRET_TITLE_XYZ"}')
    const lastPut = job({ n: 11, status: 'queued', stage: 'queue', updatedAt: stamp(0) })
    await store.putJob(lastPut)

    const listed = await store.listRecentJobs(2)
    expect(listed.map((item) => item.jobId)).toEqual([newer.jobId, olderWrite.jobId])
    expect(listed.some((item) => item.jobId === lastPut.jobId)).toBe(false)
    expect(listed.some((item) => item.jobId === hidden.jobId)).toBe(false)

    await bucket.put(clipJobKey(jobId(12)), '{', {
      customMetadata: { updatedAt: '2099-01-01T00:00:00.000Z' },
    })
    expect((await store.listRecentJobs(1)).map((item) => item.jobId)).toEqual([newer.jobId])

    const { app, env } = appWith(store)
    const response = await app.request('/clip/recent', {}, env)
    const html = await response.text()
    expect(html).toContain(hidden.jobId)
    expect(html).toContain('error.code: fetch_failed')
    expect(html).toContain('class="clip-failed"')
    expect(html).not.toContain(SECRET_TITLE)
    expect(html).not.toContain(SECRET_BODY)
    expect(html).not.toContain('secret.example')
    expect(html).not.toContain(SECRET_MESSAGE)
    expect(html).not.toContain(TEST_CLIP_TOKEN)
    expect(html).not.toContain('contentHtml')
  })
})
