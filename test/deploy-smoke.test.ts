import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { extractArticle } from '../src/extract/extract-article'
import { detectLanguage } from '../src/extract/detect-language'
import { buildEpub } from '../src/epub/build-epub'
import {
  DEFAULT_SMOKE_ARTICLE_URL,
  SMOKE_MAX_WAIT_MS,
  SMOKE_PAGE_TITLE,
  SMOKE_PHRASE,
  SMOKE_SECRET_NAMES,
} from '../src/smoke/constants'
import { verifySmokeEpub } from '../src/smoke/epub'
import { buildSmokeSlackMessage } from '../src/smoke/message'
import { redactSmokeText } from '../src/smoke/redact'
import {
  cleanupSmokeArticle,
  missingSmokeSecrets,
  notificationForState,
  notifyIfSmokeFailed,
  requestTarget,
  resolveSmokeArticleUrl,
  runDeploySmoke,
  smokeMayHavePosted,
  type SmokeSettings,
  type SmokeStateFile,
} from '../src/smoke/run'
import { parseWorkerDeploymentVersion } from '../src/smoke/worker-version'
import { articleIdFromCanonicalUrl, parseHttpUrl } from '../src/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'smoke-clip-token-value'
const USER = 'smoke-opds-user'
const PASS = 'smoke-opds-password-value'
const WEBHOOK = 'https://hooks.slack.example/services/T000/B000/secret-hook'
const ARTICLE = 'https://fixture.example/smoke/article.html'
const ORIGIN = 'https://worker.example'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const VERSION = '01234567-89ab-cdef-0123-456789abcdef'
const RUN = 'https://github.com/marufeuille/xteink-read-later/actions/runs/123'
const JOB = 'job_0123456789abcdef0123456789abcdef'
const ART = 'art_0123456789abcdef0123456789abcdef'
const NOW = Date.parse('2026-10-05T00:00:00.000Z')
const HTML = `<!DOCTYPE html><html lang="ja"><head><title>${SMOKE_PAGE_TITLE}</title></head><body><article><p>${SMOKE_PHRASE}</p></article></body></html>`

const secrets = [TOKEN, USER, PASS, WEBHOOK, ARTICLE, SMOKE_PHRASE, DEFAULT_SMOKE_ARTICLE_URL]

function settings(overrides: Partial<SmokeSettings> = {}): SmokeSettings {
  return {
    clipToken: TOKEN,
    opdsUsername: USER,
    opdsPassword: PASS,
    slackWebhookUrl: WEBHOOK,
    articleUrl: ARTICLE,
    origin: ORIGIN,
    githubSha: SHA,
    workerVersion: VERSION,
    runUrl: RUN,
    ...overrides,
  }
}

function assertNoLeak(text: string) {
  for (const secret of secrets) {
    expect(text).not.toContain(secret)
  }
}

async function epubWith(phrase: string): Promise<Uint8Array> {
  const url = parseHttpUrl(ARTICLE)
  if (url === null) {
    throw new Error('url')
  }
  return buildEpub({
    title: SMOKE_PAGE_TITLE,
    author: null,
    publishedAt: null,
    sourceUrl: url,
    canonicalUrl: url,
    contentHtml: `<p>${phrase}</p><p>補足の文章です。</p>`,
    language: 'ja',
    translated: false,
  })
}

describe('deploy smoke script', () => {
  it('keeps the slack message on the allowlisted fields', () => {
    const message = buildSmokeSlackMessage({
      githubSha: SHA,
      workerVersion: VERSION,
      failedStep: 'poll-job',
      jobId: JOB,
      lastStage: 'extract',
      errorKind: 'fetch_failed',
      runUrl: RUN,
    })
    expect(message).toBe(
      `[deploy-smoke] github.sha=${SHA} workerVersion=${VERSION} failedStep=poll-job jobId=${JOB} lastStage=extract errorKind=fetch_failed runUrl=${RUN}`,
    )
    expect(message.startsWith('[deploy-smoke]')).toBe(true)

    const leaked = buildSmokeSlackMessage({
      githubSha: ARTICLE,
      workerVersion: TOKEN,
      failedStep: SMOKE_PHRASE,
      jobId: WEBHOOK,
      lastStage: PASS,
      errorKind: `fetch_failed ${ARTICLE}`,
      runUrl: ARTICLE,
    })
    expect(leaked.startsWith('[deploy-smoke]')).toBe(true)
    assertNoLeak(leaked)
    expect(leaked).toContain('github.sha=unknown')
    expect(leaked).toContain('failedStep=unknown')
    expect(leaked).toContain('jobId=-')
    expect(leaked).toContain('runUrl=-')
  })

  it('redacts secrets and article URLs in logs', () => {
    const line = redactSmokeText(
      `token=${TOKEN} pass=${PASS} hook=${WEBHOOK} url=${ARTICLE} phrase=${SMOKE_PHRASE} run=${RUN}`,
      [TOKEN, PASS, WEBHOOK, ARTICLE, SMOKE_PHRASE],
      [RUN],
    )
    assertNoLeak(line)
    expect(line).toContain(RUN)
  })

  it('reads a worker version id and drops other deployment fields', () => {
    const version = parseWorkerDeploymentVersion({
      result: {
        latest: {
          author_email: 'person@example.com',
          versions: [{ version_id: VERSION, percentage: 100 }],
        },
      },
    })
    expect(version).toBe(VERSION)
    expect(version).not.toContain('person@example.com')
    expect(parseWorkerDeploymentVersion({ result: { note: ARTICLE } })).toBe('unknown')
  })

  it('skips without fetching when each smoke secret is missing', async () => {
    const { slackWebhookUrl: _webhook, ...withoutWebhook } = settings()
    const blanks: Array<{ readonly name: (typeof SMOKE_SECRET_NAMES)[number]; readonly settings: SmokeSettings }> = [
      { name: 'SMOKE_CLIP_TOKEN', settings: settings({ clipToken: '' }) },
      { name: 'SMOKE_OPDS_USERNAME', settings: settings({ opdsUsername: '' }) },
      { name: 'SMOKE_OPDS_PASSWORD', settings: settings({ opdsPassword: '   ' }) },
      { name: 'SMOKE_SLACK_WEBHOOK_URL', settings: withoutWebhook },
    ]
    expect(blanks.map((item) => item.name)).toEqual([...SMOKE_SECRET_NAMES])
    for (const blank of blanks) {
      const logs: string[] = []
      const fetchImpl = vi.fn(async () => new Response('no'))
      const notify = vi.fn(async (_message: string) => {})
      const result = await runDeploySmoke({
        settings: blank.settings,
        fetch: fetchImpl,
        log: (line) => logs.push(line),
        now: () => NOW,
      })
      expect(result.kind).toBe('skipped')
      const text = logs.join('\n')
      expect(text).toContain('未設定')
      expect(text).toContain(blank.name)
      expect(text).toContain(`github.sha=${SHA}`)
      expect(text).toContain(`workerVersion=${VERSION}`)
      assertNoLeak(text)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(await notifyIfSmokeFailed(result, notify)).toBe(false)
      expect(notify).not.toHaveBeenCalled()
    }
  })

  it('skips when every smoke secret is absent', async () => {
    const logs: string[] = []
    const fetchImpl = vi.fn(async () => new Response('no'))
    const result = await runDeploySmoke({
      settings: { githubSha: SHA, workerVersion: VERSION, runUrl: RUN },
      fetch: fetchImpl,
      log: (line) => logs.push(line),
    })
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') {
      expect(result.missing).toEqual([...SMOKE_SECRET_NAMES])
    }
    const text = logs.join('\n')
    for (const name of SMOKE_SECRET_NAMES) {
      expect(text).toContain(`未設定: ${name}`)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(missingSmokeSecrets({})).toEqual([...SMOKE_SECRET_NAMES])
  })

  it('skips an invalid article URL without fetching', async () => {
    const logs: string[] = []
    const fetchImpl = vi.fn(async () => new Response('no'))
    const result = await runDeploySmoke({
      settings: settings({ articleUrl: 'not a url' }),
      fetch: fetchImpl,
      log: (line) => logs.push(line),
    })
    expect(result.kind).toBe('skipped')
    expect(logs.join('\n')).toContain('未設定: SMOKE_ARTICLE_URL')
    expect(logs.join('\n')).not.toContain('not a url')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(resolveSmokeArticleUrl('')).toBe(DEFAULT_SMOKE_ARTICLE_URL)
    expect(resolveSmokeArticleUrl('notaurl')).toBeNull()
  })

  it('skips an unreachable article URL without posting a clip', async () => {
    for (const response of [async () => new Response('missing', { status: 404 }), async () => {
      throw new TypeError('connect ECONNREFUSED')
    }]) {
      const logs: string[] = []
      const calls: string[] = []
      const result = await runDeploySmoke({
        settings: settings(),
        fetch: async (input) => {
          calls.push(requestTarget(input))
          return response()
        },
        log: (line) => logs.push(line),
        now: () => NOW,
      })
      expect(result.kind).toBe('skipped')
      expect(logs.join('\n')).toContain('未設定: SMOKE_ARTICLE_URL')
      assertNoLeak(logs.join('\n'))
      expect(calls).toEqual([ARTICLE])
    }
  })

  it('skips when the default Pages URL is unreachable', async () => {
    const logs: string[] = []
    const calls: string[] = []
    const result = await runDeploySmoke({
      settings: settings({ articleUrl: '' }),
      fetch: async (input) => {
        calls.push(requestTarget(input))
        return new Response('missing', { status: 404 })
      },
      log: (line) => logs.push(line),
    })
    expect(result.kind).toBe('skipped')
    expect(logs.join('\n')).toContain('未設定: SMOKE_ARTICLE_URL')
    expect(logs.join('\n')).not.toContain('github.io')
    expect(calls).toEqual([DEFAULT_SMOKE_ARTICLE_URL])
  })

  it('waits at most five minutes and posts the clip once', async () => {
    expect(SMOKE_MAX_WAIT_MS).toBe(5 * 60 * 1000)
    let clock = NOW
    let posts = 0
    const logs: string[] = []
    const result = await runDeploySmoke({
      settings: settings(),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      log: (line) => logs.push(line),
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? 'GET'
        if (url === ARTICLE) {
          return new Response(HTML, { status: 200 })
        }
        if (url === `${ORIGIN}/clip` && method === 'POST') {
          posts += 1
          return Response.json({ jobId: JOB, status: 'queued', sourceUrl: ARTICLE }, { status: 202 })
        }
        if (url === `${ORIGIN}/clip/jobs/${JOB}`) {
          return Response.json({
            jobId: JOB,
            status: 'running',
            sourceUrl: ARTICLE,
            stages: [{ stage: 'fetch', durationMs: 1, attempt: 1 }],
          })
        }
        throw new Error(`unexpected ${method} ${url}`)
      },
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.state.failedStep).toBe('poll-job')
      expect(result.state.errorKind).toBe('timeout')
      expect(result.state.jobId).toBe(JOB)
    }
    expect(posts).toBe(1)
    expect(clock - NOW).toBeGreaterThanOrEqual(SMOKE_MAX_WAIT_MS)
    assertNoLeak(logs.join('\n'))
  })

  it('stops on a failed job without a second clip or an epub download', async () => {
    const calls: string[] = []
    const result = await runDeploySmoke({
      settings: settings(),
      now: () => NOW,
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? 'GET'
        calls.push(`${method} ${url}`)
        if (url === ARTICLE) {
          return new Response(HTML, { status: 200 })
        }
        if (method === 'POST') {
          return Response.json({ jobId: JOB, sourceUrl: ARTICLE }, { status: 202 })
        }
        return Response.json({
          jobId: JOB,
          status: 'failed',
          sourceUrl: ARTICLE,
          error: { code: 'extract_failed', message: `Could not extract ${ARTICLE}` },
          stages: [{ stage: 'extract', durationMs: 4, attempt: 1, errorKind: 'extract_failed' }],
        })
      },
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.state.errorKind).toBe('extract_failed')
      expect(result.state.lastStage).toBe('extract')
    }
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1)
    expect(calls.some((call) => call.includes('.epub'))).toBe(false)
  })

  it('notifies when the clip token is rejected and omits secrets from the message', async () => {
    const notify = vi.fn(async (_message: string) => {})
    const result = await runDeploySmoke({
      settings: settings(),
      now: () => NOW,
      fetch: async (input, init) => {
        const url = requestTarget(input)
        if (url === ARTICLE) {
          return new Response(HTML, { status: 200 })
        }
        if ((init?.method ?? 'GET') === 'POST') {
          return new Response('unauthorized', { status: 401 })
        }
        throw new Error(`unexpected ${url}`)
      },
    })
    expect(result.kind).toBe('failed')
    expect(await notifyIfSmokeFailed(result, notify)).toBe(true)
    expect(notify).toHaveBeenCalledOnce()
    const message = notify.mock.calls[0]?.[0] ?? ''
    expect(message.startsWith('[deploy-smoke]')).toBe(true)
    expect(message).toContain('failedStep=post-clip')
    expect(message).toContain('errorKind=http_401')
    expect(message).toContain(`runUrl=${RUN}`)
    assertNoLeak(message)
  })

  it('does not follow catalog links off the origin and checks the epub phrase', async () => {
    const bytes = await epubWith(SMOKE_PHRASE)
    const calls: string[] = []
    const notify = vi.fn(async () => {})
    const result = await runDeploySmoke({
      settings: settings(),
      now: () => NOW,
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? 'GET'
        calls.push(`${method} ${url}`)
        if (url === ARTICLE && method === 'GET') {
          return new Response(HTML, { status: 200 })
        }
        if (url === `${ORIGIN}/clip` && method === 'POST') {
          return Response.json({ jobId: JOB, sourceUrl: ARTICLE }, { status: 202 })
        }
        if (url === `${ORIGIN}/clip/jobs/${JOB}`) {
          return Response.json({
            jobId: JOB,
            status: 'ready',
            sourceUrl: ARTICLE,
            id: ART,
            stages: [{ stage: 'epub', durationMs: 2, attempt: 1 }],
          })
        }
        if (url === `${ORIGIN}/opds/clip/2026-10-05`) {
          return new Response(
            `<feed><link href="https://evil.example/secret"/><link href="${ARTICLE}"/><link href="${ORIGIN}/opds/clip/2026-10-04"/></feed>`,
            { status: 200, headers: { 'content-type': 'application/atom+xml' } },
          )
        }
        if (url === `${ORIGIN}/opds/clip/2026-10-04`) {
          return new Response(`<entry><id>${ART}</id></entry>`, { status: 200 })
        }
        if (url === `${ORIGIN}/opds/download/${ART}.epub`) {
          return new Response(bytes, { status: 200 })
        }
        throw new Error(`unexpected ${method} ${url}`)
      },
    })
    expect(result.kind).toBe('passed')
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([`POST ${ORIGIN}/clip`])
    expect(calls.some((call) => call.includes('evil.example'))).toBe(false)
    expect(calls.filter((call) => call.includes(ARTICLE))).toEqual([`GET ${ARTICLE}`])
    expect(await notifyIfSmokeFailed(result, notify)).toBe(false)

    const missingPhrase = await runDeploySmoke({
      settings: settings(),
      now: () => NOW,
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? 'GET'
        if (url === ARTICLE) return new Response(HTML, { status: 200 })
        if (method === 'POST') return Response.json({ jobId: JOB }, { status: 202 })
        if (url.endsWith(JOB)) {
          return Response.json({ jobId: JOB, status: 'ready', id: ART, stages: [] })
        }
        if (url.includes('/opds/clip/')) return new Response(`<id>${ART}</id>`, { status: 200 })
        if (url.endsWith('.epub')) return new Response(await epubWith('別の文'), { status: 200 })
        throw new Error(url)
      },
    })
    expect(missingPhrase.kind).toBe('failed')
    if (missingPhrase.kind === 'failed') {
      expect(missingPhrase.state.failedStep).toBe('verify-epub')
      expect(missingPhrase.state.errorKind).toBe('epub_phrase')
    }
    const phraseNotify = vi.fn(async (message: string) => {
      expect(message.startsWith('[deploy-smoke]')).toBe(true)
      assertNoLeak(message)
    })
    expect(await notifyIfSmokeFailed(missingPhrase, phraseNotify)).toBe(true)
  })

  it('deletes the recorded article and does nothing when the run never clipped', async () => {
    const deleted: string[] = []
    const state: SmokeStateFile = {
      outcome: 'failed',
      githubSha: SHA,
      workerVersion: VERSION,
      runUrl: RUN,
      step: 'poll-job',
      failedStep: 'poll-job',
      jobId: JOB,
      articleId: ART,
      lastStage: 'fetch',
      errorKind: 'timeout',
      missing: [],
      cleanupErrorKind: null,
    }
    const cleaned = await cleanupSmokeArticle({
      state,
      settings: settings(),
      fetch: async (input, init) => {
        deleted.push(`${init?.method ?? 'GET'} ${requestTarget(input)}`)
        return Response.json({ deleted: true }, { status: 200 })
      },
    })
    expect(cleaned.ok).toBe(true)
    expect(deleted.some((call) => call === `DELETE ${ORIGIN}/articles/${ART}`)).toBe(true)

    const fetchImpl = vi.fn(async () => new Response('no'))
    const idle = await cleanupSmokeArticle({
      state: { ...state, outcome: 'skipped', jobId: null, articleId: null },
      settings: settings({ clipToken: '' }),
      fetch: fetchImpl,
    })
    expect(idle.ok).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(smokeMayHavePosted(null)).toBe(true)
    expect(smokeMayHavePosted({ ...state, outcome: 'skipped', jobId: null, articleId: null })).toBe(false)
  })

  it('deletes by URL hash when the clip may have been accepted without an id', async () => {
    const articleUrl = parseHttpUrl(ARTICLE)
    if (articleUrl === null) {
      throw new Error('url')
    }
    const hashed = await articleIdFromCanonicalUrl(articleUrl)
    expect(hashed).not.toBe(ART)
    const base: SmokeStateFile = {
      outcome: 'failed',
      githubSha: SHA,
      workerVersion: VERSION,
      runUrl: RUN,
      step: 'post-clip',
      failedStep: 'post-clip',
      jobId: null,
      articleId: null,
      lastStage: null,
      errorKind: 'invalid_response',
      missing: [],
      cleanupErrorKind: null,
    }
    const cases: SmokeStateFile[] = [
      base,
      { ...base, outcome: 'running', step: 'post-clip', failedStep: null, errorKind: null },
      { ...base, errorKind: 'network' },
    ]
    for (const state of cases) {
      const deleted: string[] = []
      const cleaned = await cleanupSmokeArticle({
        state,
        settings: settings(),
        fetch: async (input, init) => {
          deleted.push(`${init?.method ?? 'GET'} ${requestTarget(input)}`)
          return new Response(null, { status: 404 })
        },
      })
      expect(cleaned.ok).toBe(true)
      expect(deleted).toEqual([`DELETE ${ORIGIN}/articles/${hashed}`])
    }

    const missingFile: string[] = []
    const fromMissingFile = await cleanupSmokeArticle({
      state: null,
      settings: settings(),
      fetch: async (input, init) => {
        missingFile.push(`${init?.method ?? 'GET'} ${requestTarget(input)}`)
        return Response.json({ deleted: true }, { status: 200 })
      },
    })
    expect(fromMissingFile.ok).toBe(true)
    expect(missingFile).toEqual([`DELETE ${ORIGIN}/articles/${hashed}`])

    const preflight = vi.fn(async () => new Response('no'))
    const beforePost = await cleanupSmokeArticle({
      state: { ...base, step: 'article-preflight', failedStep: 'article-preflight', errorKind: 'phrase_missing' },
      settings: settings(),
      fetch: preflight,
    })
    expect(beforePost.ok).toBe(true)
    expect(preflight).not.toHaveBeenCalled()
  })

  it('includes cleanupErrorKind when the run and delete both fail', () => {
    const failed: SmokeStateFile = {
      outcome: 'failed',
      githubSha: SHA,
      workerVersion: VERSION,
      runUrl: RUN,
      step: 'poll-job',
      failedStep: 'poll-job',
      jobId: JOB,
      articleId: ART,
      lastStage: 'fetch',
      errorKind: 'timeout',
      missing: [],
      cleanupErrorKind: 'http_503',
    }
    const fields = notificationForState(failed, {})
    if (fields === null) {
      throw new Error('fields')
    }
    expect(fields.errorKind).toBe('timeout')
    expect(fields.cleanupErrorKind).toBe('http_503')
    const message = buildSmokeSlackMessage(fields)
    expect(message).toContain('errorKind=timeout')
    expect(message).toContain('cleanupErrorKind=http_503')
    expect(message.indexOf('errorKind=timeout')).toBeLessThan(message.indexOf('cleanupErrorKind=http_503'))
    assertNoLeak(message)

    const deleteOnly = notificationForState({ ...failed, outcome: 'passed', failedStep: null, errorKind: null }, {})
    if (deleteOnly === null) {
      throw new Error('deleteOnly')
    }
    expect(deleteOnly.failedStep).toBe('delete')
    expect(deleteOnly.errorKind).toBe('http_503')
    expect(deleteOnly.cleanupErrorKind).toBeUndefined()
    expect(buildSmokeSlackMessage(deleteOnly)).not.toContain('cleanupErrorKind')
  })

  it('matches the Pages article, the wrangler URL, and the workflow secrets', async () => {
    const html = readFileSync(join(root, 'pages/smoke/article.html'), 'utf8')
    expect(html).toContain(`<title>${SMOKE_PAGE_TITLE}</title>`)
    expect(html).toContain(SMOKE_PHRASE)
    expect(SMOKE_PAGE_TITLE.startsWith('[smoke]')).toBe(true)
    const url = parseHttpUrl(DEFAULT_SMOKE_ARTICLE_URL)
    if (url === null) {
      throw new Error('url')
    }
    const extracted = await extractArticle({
      requestedUrl: url,
      finalUrl: url,
      contentType: 'text/html; charset=utf-8',
      html,
    })
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) {
      return
    }
    expect(extracted.value.title.startsWith('[smoke]')).toBe(true)
    expect(extracted.value.contentHtml).toContain(SMOKE_PHRASE)
    expect(detectLanguage({ contentHtml: extracted.value.contentHtml, htmlLang: 'ja' })).toBe('ja')
    const checked = verifySmokeEpub(
      await buildEpub({ ...extracted.value, language: 'ja', translated: false }),
      SMOKE_PHRASE,
    )
    expect(checked.ok).toBe(true)

    const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
    expect(wrangler).toContain(`"SMOKE_ARTICLE_URL": "${DEFAULT_SMOKE_ARTICLE_URL}"`)
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('secrets.SMOKE_CLIP_TOKEN')
    expect(ci).toContain('secrets.SMOKE_OPDS_USERNAME')
    expect(ci).toContain('secrets.SMOKE_OPDS_PASSWORD')
    expect(ci).toContain('secrets.SMOKE_SLACK_WEBHOOK_URL')
    expect(ci).toContain('if: always()')
    expect(ci).toContain('if: ${{ failure() || cancelled() }}')
    const smokeJob = (ci.split('\n  deploy-smoke:')[1] ?? '').split('\n  deploy-rollback:')[0] ?? ''
    const jobTimeout = Number(/^    timeout-minutes: (\d+)/m.exec(smokeJob)?.[1])
    const stepTimeouts = [...smokeJob.matchAll(/\n        timeout-minutes: (\d+)/g)].map((match) => Number(match[1]))
    expect(stepTimeouts).toEqual([1, 1, 3, 8, 2, 1, 1])
    expect(stepTimeouts.reduce((sum, minutes) => sum + minutes, 0)).toBeLessThanOrEqual(jobTimeout)
    expect(jobTimeout).toBe(18)
    expect(ci).not.toMatch(/secrets\.CLIP_TOKEN/)
    expect(ci).not.toMatch(/secrets\.OPDS_USERNAME/)
    expect(ci).not.toMatch(/secrets\.OPDS_PASSWORD/)
    const doc = readFileSync(join(root, 'docs/deploy-smoke.md'), 'utf8')
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const env = readFileSync(join(root, 'src/env.d.ts'), 'utf8')
    expect(doc).toContain('SMOKE_CLIP_TOKEN_SHA256')
    expect(doc).toContain('SMOKE_OPDS_BASIC_SHA256')
    expect(doc).toContain("printf '%s'")
    expect(doc).not.toContain('npx wrangler secret put SMOKE_CLIP_TOKEN\n')
    expect(readme).toContain('本番の値は置かない。置くのはスモーク専用の値だけ。')
    expect(readme).toContain('npx wrangler secret put SMOKE_CLIP_TOKEN_SHA256')
    expect(readme).toContain('npx wrangler secret put SMOKE_OPDS_BASIC_SHA256')
    expect(readme).not.toContain('npx wrangler secret put SMOKE_CLIP_TOKEN\n')
    expect(env).toContain('SMOKE_CLIP_TOKEN_SHA256')
    expect(env).toContain('SMOKE_OPDS_BASIC_SHA256')
    expect(env).not.toContain('SMOKE_CLIP_TOKEN:')
    expect(env).not.toContain('SMOKE_OPDS_USERNAME')
    expect(env).not.toContain('SMOKE_OPDS_PASSWORD')
    const pages = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8')
    expect(pages).toContain('actions/upload-pages-artifact')
    expect(pages).toContain('actions/deploy-pages')
    expect(pages).toContain('pages/smoke/article.html')
  })
})
