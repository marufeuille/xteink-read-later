import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  CLIP_STATUS_USAGE,
  eventsForJob,
  fetchClipJobSnapshot,
  formatClipStatus,
  inferDisplayStatus,
  parseClipStatusArgs,
  parseLogLine,
  resolveClipJobId,
  runClipStatus,
  workerBaseUrl,
  type ClipJobSnapshot,
  type PipelineLogEvent,
  type TailProcess,
} from '../src/cli/clip-status'
import { clipJobIdFromUrl, parseHttpUrl } from '../src/types'

const JOB_ID = 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN = 'clip-test-token'
const SECRET = 'sk-must-not-leak'

function event(partial: Omit<PipelineLogEvent, 'stage' | 'durationMs'> & {
  stage?: PipelineLogEvent['stage']
  durationMs?: number
}): PipelineLogEvent {
  return {
    jobId: JOB_ID,
    stage: 'fetch',
    durationMs: 10,
    ...partial,
  }
}

function runningJob(): ClipJobSnapshot {
  return {
    kind: 'job',
    body: {
      jobId: JOB_ID,
      status: 'running',
      sourceUrl: 'https://example.com/article',
      attempt: 2,
    },
  }
}

describe('clip-status CLI', () => {
  it('parses jobId or URL flags', () => {
    expect(parseClipStatusArgs([JOB_ID])).toEqual({ target: JOB_ID, tail: false, stdin: false })
    expect(parseClipStatusArgs(['--tail', JOB_ID])).toEqual({
      target: JOB_ID,
      tail: true,
      stdin: false,
    })
    expect(parseClipStatusArgs(['--stdin', JOB_ID])).toEqual({
      target: JOB_ID,
      tail: false,
      stdin: true,
    })
    expect(parseClipStatusArgs(['--tail', '--stdin', JOB_ID])).toMatchObject({ error: expect.stringContaining('--tail') })
    expect(parseClipStatusArgs([])).toMatchObject({ error: CLIP_STATUS_USAGE })
    expect(parseClipStatusArgs(['--wat', JOB_ID])).toMatchObject({ error: expect.stringContaining('不明なオプション') })
  })

  it('resolves the same jobId as the Worker for a URL', async () => {
    const url = parseHttpUrl('https://example.com/article')
    if (url === null) {
      throw new Error('url')
    }
    expect(await resolveClipJobId(JOB_ID)).toBe(JOB_ID)
    expect(await resolveClipJobId(url)).toBe(await clipJobIdFromUrl(url))
    expect(await resolveClipJobId('ftp://example.com/x')).toMatchObject({ error: expect.stringContaining('jobId') })
  })

  it('parses raw pipeline JSON and wrangler tail envelopes', () => {
    const raw = parseLogLine(
      JSON.stringify({
        event: 'pipeline',
        jobId: JOB_ID,
        runId: 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        attempt: 1,
        stage: 'translate',
        durationMs: 20,
        errorKind: 'translate_failed',
      }),
    )
    expect(raw).toEqual([
      {
        jobId: JOB_ID,
        runId: 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        attempt: 1,
        stage: 'translate',
        durationMs: 20,
        errorKind: 'translate_failed',
      },
    ])
    const nested = parseLogLine(
      JSON.stringify({
        outcome: 'ok',
        logs: [
          {
            message: [
              JSON.stringify({
                event: 'pipeline',
                jobId: JOB_ID,
                stage: 'fetch',
                durationMs: 8,
              }),
            ],
          },
        ],
      }),
    )
    expect(nested).toEqual([{ jobId: JOB_ID, stage: 'fetch', durationMs: 8 }])
    expect(parseLogLine('not-json')).toEqual([])
    expect(parseLogLine(JSON.stringify({ event: 'pipeline', stage: 'nope', durationMs: 1 }))).toEqual(
      [],
    )
  })

  it('ignores other jobs and does not keep article text', () => {
    const matched = eventsForJob(
      [
        event({ stage: 'fetch', jobId: JOB_ID }),
        event({ stage: 'fetch', jobId: 'job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
        event({ stage: 'extract', jobId: JOB_ID }),
      ],
      JOB_ID,
    )
    expect(matched.map((item) => item.stage)).toEqual(['fetch', 'extract'])
    expect(JSON.stringify(matched)).not.toContain('<p>')
  })

  it('distinguishes running, retry wait, ready, failed, and unknown', () => {
    expect(inferDisplayStatus(runningJob(), [])).toBe('処理中（工程不明）')
    expect(inferDisplayStatus(runningJob(), [event({ stage: 'translate' })])).toBe('処理中')
    expect(
      inferDisplayStatus(runningJob(), [event({ stage: 'translate', errorKind: 'translate_failed' })]),
    ).toBe('再試行待ち')
    expect(
      inferDisplayStatus(
        {
          kind: 'job',
          body: {
            jobId: JOB_ID,
            status: 'ready',
            sourceUrl: 'https://example.com/article',
            id: 'art_cccccccccccccccccccccccccccccccc',
            epubPath: '/articles/art_cccccccccccccccccccccccccccccccc/book.epub',
          },
        },
        [],
      ),
    ).toBe('完了')
    expect(
      inferDisplayStatus(
        {
          kind: 'job',
          body: {
            jobId: JOB_ID,
            status: 'failed',
            sourceUrl: 'https://example.com/article',
            error: { code: 'fetch_failed', message: 'HTTP 404' },
          },
        },
        [],
      ),
    ).toBe('失敗')
    expect(inferDisplayStatus({ kind: 'missing' }, [])).toBe('不明（job なし）')
    expect(inferDisplayStatus({ kind: 'unauthorized' }, [])).toBe('不明（認証失敗）')
    expect(inferDisplayStatus({ kind: 'skipped', reason: 'CLIP_TOKEN が無い' }, [])).toBe(
      '不明（CLIP_TOKEN が無い）',
    )
  })

  it('marks unseen stages as 不明 and keeps GET failure details', () => {
    const text = formatClipStatus({
      jobId: JOB_ID,
      job: {
        kind: 'job',
        body: {
          jobId: JOB_ID,
          status: 'failed',
          sourceUrl: 'https://example.com/article',
          error: { code: 'translate_failed', message: 'OpenAI HTTP 503' },
        },
      },
      events: [
        event({ stage: 'queue', durationMs: 4, attempt: 0 }),
        event({ stage: 'fetch', durationMs: 12, attempt: 1 }),
        event({ stage: 'translate', durationMs: 30, attempt: 1, errorKind: 'translate_failed' }),
      ],
    })
    expect(text).toContain('状態     失敗')
    expect(text).toContain('失敗     translate_failed: OpenAI HTTP 503')
    expect(text).toContain('fetch     完了')
    expect(text).toMatch(/translate\s+失敗/)
    expect(text).toContain('epub      不明')
    expect(text).toContain('store     不明')
    expect(text).toContain('ライブログに無い工程は「不明」です')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('<p>')
  })

  it('uses WORKER as the base URL alias and fetches the job with Bearer', async () => {
    expect(workerBaseUrl({ WORKER: 'https://example.workers.dev/' })).toBe(
      'https://example.workers.dev',
    )
    const snapshot = await fetchClipJobSnapshot({
      baseUrl: 'https://example.workers.dev',
      token: TOKEN,
      jobId: JOB_ID,
      fetch: async (input, init) => {
        expect(String(input)).toBe(`https://example.workers.dev/clip/jobs/${JOB_ID}`)
        expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` })
        return new Response(
          JSON.stringify({
            jobId: JOB_ID,
            status: 'queued',
            sourceUrl: 'https://example.com/article',
            attempt: 0,
            extracted: { contentHtml: '<p>secret</p>' },
          }),
          { status: 200 },
        )
      },
    })
    expect(snapshot).toEqual({
      kind: 'job',
      body: {
        jobId: JOB_ID,
        status: 'queued',
        sourceUrl: 'https://example.com/article',
        attempt: 0,
      },
    })
  })

  it('prints GET-only status without live stages', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runClipStatus({
      argv: [JOB_ID],
      env: { CLIP_TOKEN: TOKEN, CLIP_BASE_URL: 'https://example.workers.dev' },
      stdin: Readable.from([]),
      stdout: { write(chunk) { stdout.push(chunk) } },
      stderr: { write(chunk) { stderr.push(chunk) } },
      stdinIsTTY: true,
      fetch: async () =>
        new Response(
          JSON.stringify({
            jobId: JOB_ID,
            status: 'running',
            sourceUrl: 'https://example.com/article',
            attempt: 1,
          }),
          { status: 200 },
        ),
    })
    expect(code).toBe(0)
    const text = stdout.join('')
    expect(text).toContain('処理中（工程不明）')
    expect(text).toContain('fetch     不明')
    expect(text).not.toContain(TOKEN)
    expect(stderr.join('')).toBe('')
  })

  it('formats piped wrangler tail lines and does not echo the token', async () => {
    const stdout: string[] = []
    const line = JSON.stringify({
      event: 'pipeline',
      jobId: JOB_ID,
      attempt: 1,
      stage: 'fetch',
      durationMs: 9,
    })
    const code = await runClipStatus({
      argv: ['--stdin', JOB_ID],
      env: { CLIP_TOKEN: TOKEN, CLIP_BASE_URL: 'https://example.workers.dev' },
      stdin: Readable.from([`${line}\n`]),
      stdout: { write(chunk) { stdout.push(chunk) } },
      stderr: { write() {} },
      stdinIsTTY: false,
      fetch: async () =>
        new Response(
          JSON.stringify({
            jobId: JOB_ID,
            status: 'running',
            sourceUrl: 'https://example.com/article',
            attempt: 1,
          }),
          { status: 200 },
        ),
    })
    expect(code).toBe(0)
    const text = stdout.join('')
    expect(text).toContain('処理中')
    expect(text).toContain('fetch     完了')
    expect(text).toContain('9ms')
    expect(text).not.toContain(TOKEN)
  })

  it('tails until the job is ready', async () => {
    const stdout: string[] = []
    let fetches = 0
    let killed = false
    const tail: TailProcess = {
      stdout: Readable.from([
        `${JSON.stringify({
          event: 'pipeline',
          jobId: JOB_ID,
          attempt: 1,
          stage: 'store',
          durationMs: 3,
        })}\n`,
      ]),
      kill() {
        killed = true
      },
      exit: new Promise(() => {}),
    }
    const code = await runClipStatus({
      argv: ['--tail', JOB_ID],
      env: { CLIP_TOKEN: TOKEN, CLIP_BASE_URL: 'https://example.workers.dev' },
      stdin: Readable.from([]),
      stdout: { write(chunk) { stdout.push(chunk) } },
      stderr: { write() {} },
      stdinIsTTY: true,
      fetch: async () => {
        fetches += 1
        const status = fetches <= 2 ? 'running' : 'ready'
        return new Response(
          JSON.stringify(
            status === 'running'
              ? {
                  jobId: JOB_ID,
                  status: 'running',
                  sourceUrl: 'https://example.com/article',
                  attempt: 1,
                }
              : {
                  jobId: JOB_ID,
                  status: 'ready',
                  sourceUrl: 'https://example.com/article',
                  id: 'art_cccccccccccccccccccccccccccccccc',
                  epubPath: '/articles/art_cccccccccccccccccccccccccccccccc/book.epub',
                },
          ),
          { status: 200 },
        )
      },
      spawnTail: () => tail,
      sleep: async (_ms, signal) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      },
    })
    expect(code).toBe(0)
    expect(killed).toBe(true)
    const text = stdout.join('')
    expect(text).toContain('ライブログ:')
    expect(text).toContain('store')
    expect(text).toContain('完了')
    expect(text).not.toContain(TOKEN)
  })

  it('exits on unauthorized without printing the token', async () => {
    const stderr: string[] = []
    const code = await runClipStatus({
      argv: [JOB_ID],
      env: { CLIP_TOKEN: TOKEN, CLIP_BASE_URL: 'https://example.workers.dev' },
      stdin: Readable.from([]),
      stdout: { write() {} },
      stderr: { write(chunk) { stderr.push(chunk) } },
      stdinIsTTY: true,
      fetch: async () => new Response('{}', { status: 401 }),
    })
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('CLIP_TOKEN')
    expect(stderr.join('')).not.toContain(TOKEN)
  })

  it('does not start wrangler tail when the job is missing', async () => {
    let spawned = false
    const stderr: string[] = []
    const code = await runClipStatus({
      argv: ['--tail', JOB_ID],
      env: { CLIP_TOKEN: TOKEN, CLIP_BASE_URL: 'https://example.workers.dev' },
      stdin: Readable.from([]),
      stdout: { write() {} },
      stderr: { write(chunk) { stderr.push(chunk) } },
      stdinIsTTY: true,
      fetch: async () => new Response('{}', { status: 404 }),
      spawnTail: () => {
        spawned = true
        throw new Error('should not spawn')
      },
    })
    expect(code).toBe(1)
    expect(spawned).toBe(false)
    expect(stderr.join('')).toContain('job が無い')
  })

  it('tails without CLIP_TOKEN until the log stream ends', async () => {
    const stdout: string[] = []
    const line = JSON.stringify({
      event: 'pipeline',
      jobId: JOB_ID,
      attempt: 1,
      stage: 'fetch',
      durationMs: 5,
    })
    const code = await runClipStatus({
      argv: ['--tail', JOB_ID],
      env: { CLIP_BASE_URL: 'https://example.workers.dev' },
      stdin: Readable.from([]),
      stdout: { write(chunk) { stdout.push(chunk) } },
      stderr: { write() {} },
      stdinIsTTY: true,
      fetch: async () => {
        throw new Error('GET should be skipped without CLIP_TOKEN')
      },
      spawnTail: () => ({
        stdout: Readable.from([`${line}\n`]),
        kill() {},
        exit: new Promise(() => {}),
      }),
    })
    expect(code).toBe(0)
    const text = stdout.join('')
    expect(text).toContain('不明（CLIP_TOKEN が無い）')
    expect(text).toContain('fetch     完了')
  })
})
