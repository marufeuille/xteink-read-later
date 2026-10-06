import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  SMOKE_PREFLIGHT_RETRY_DELAY_MS,
  SMOKE_SECRET_NAMES,
} from '../src/smoke/constants'
import { verifySmokeEpub } from '../src/smoke/epub'
import { buildSmokeSlackMessage } from '../src/smoke/message'
import {
  articleUnreachableSummary,
  preflightStatusErrorKind,
  preflightTransportErrorKind,
} from '../src/smoke/preflight'
import { redactSmokeText } from '../src/smoke/redact'
import { recordDeploySmokeResult } from '../src/smoke/report'
import { runDeployRollback } from '../src/smoke/rollback'
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
import { isSmokeRequired, publishUnsetSkip, unsetSmokeNotice } from '../src/smoke/unset'
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
const MARKER = 'body-marker-not-a-secret'
const PREVIOUS_VERSION = '89abcdef-0123-4567-89ab-cdef01234567'

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

async function expectNoArticleRollback(state: SmokeStateFile): Promise<void> {
  const rollback = vi.fn(async () => true)
  const verify = vi.fn(async () => 'passed' as const)
  const decided = await runDeployRollback({
    context: {
      jobResult: 'failure',
      outcome: state.outcome,
      failedStep: state.failedStep ?? '',
      errorKind: state.errorKind ?? '',
      cleanupErrorKind: '-',
      previousWorkerVersion: PREVIOUS_VERSION,
      workerVersion: VERSION,
      githubSha: SHA,
      runUrl: RUN,
      runId: '123',
    },
    diff: { paths: ['src/smoke/run.ts'], wranglerBefore: null, wranglerAfter: null, diffKnown: true },
    liveWorkerVersion: VERSION,
    rollback,
    verify,
    notify: async () => {},
    summarize: () => {},
  })
  expect(rollback).not.toHaveBeenCalled()
  expect(verify).not.toHaveBeenCalled()
  expect(decided.rolledBack).toBe(false)
  expect(decided.result).toBe('skipped:preflight')
}

async function expectNoDelete(state: SmokeStateFile): Promise<void> {
  const fetchImpl = vi.fn(async () => new Response('no'))
  const logs: string[] = []
  const cleaned = await cleanupSmokeArticle({
    state,
    settings: settings(),
    fetch: fetchImpl,
    log: (line) => logs.push(line),
  })
  expect(cleaned.ok).toBe(true)
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(logs.join('\n')).toContain('cleanup: nothing to delete')
  expect(smokeMayHavePosted(state)).toBe(false)
}

function assertFixedLine(message: string, prefix: string, keys: readonly string[], runUrl: string) {
  expect(message).not.toMatch(/[\r\n]/)
  const [head, ...parts] = message.split(' ')
  expect(head).toBe(prefix)
  expect(parts.map((part) => part.slice(0, part.indexOf('=')))).toEqual([...keys])
  for (const part of parts) {
    const value = part.slice(part.indexOf('=') + 1)
    expect(value.length).toBeGreaterThan(0)
    expect(value).not.toMatch(/\s/)
    if (!part.startsWith('runUrl=')) {
      expect(value).not.toMatch(/https?:\/\//)
    }
  }
  const urls = message.match(/https?:\/\/\S+/g) ?? []
  expect(urls).toEqual(runUrl === '-' ? [] : [runUrl])
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
      `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=poll-job errorKind=fetch_failed lastStage=extract jobId=${JOB} runUrl=${RUN}`,
    )
    assertFixedLine(
      message,
      '[deploy-smoke]',
      ['sha', 'workerVersion', 'failedStep', 'errorKind', 'lastStage', 'jobId', 'runUrl'],
      RUN,
    )

    const hash = '0123456789abcdef'.repeat(4)
    const slackToken = 'xoxb-123456789012-abcdefTOKEN'
    const leaked = buildSmokeSlackMessage({
      githubSha: `${ARTICLE}\n${SHA} ${hash}`,
      workerVersion: `${TOKEN} ${VERSION}`,
      failedStep: `${SMOKE_PHRASE}\npost-clip`,
      jobId: `${WEBHOOK}\r${JOB}`,
      lastStage: `${PASS}\nextract ${slackToken}`,
      errorKind: `fetch_failed ${ARTICLE}`,
      runUrl: `${ARTICLE}\n${RUN}`,
    })
    expect(leaked).toBe(
      '[deploy-smoke] sha=unknown workerVersion=unknown failedStep=unknown errorKind=- lastStage=- jobId=- runUrl=-',
    )
    assertFixedLine(
      leaked,
      '[deploy-smoke]',
      ['sha', 'workerVersion', 'failedStep', 'errorKind', 'lastStage', 'jobId', 'runUrl'],
      '-',
    )
    assertNoLeak(leaked)
    expect(leaked).not.toContain(hash)
    expect(leaked).not.toContain(slackToken)
    expect(leaked).not.toContain('cleanupErrorKind')
  })

  it('formats failure, cancel, and cleanup lines in the fixed key order', () => {
    const failure = buildSmokeSlackMessage({
      githubSha: SHA,
      workerVersion: VERSION,
      failedStep: 'poll-job',
      jobId: JOB,
      lastStage: 'extract',
      errorKind: 'extract_failed',
      runUrl: RUN,
    })
    const failureLine = `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=poll-job errorKind=extract_failed lastStage=extract jobId=${JOB} runUrl=${RUN}`
    expect(failure).toBe(failureLine)
    assertFixedLine(
      failure,
      '[deploy-smoke]',
      ['sha', 'workerVersion', 'failedStep', 'errorKind', 'lastStage', 'jobId', 'runUrl'],
      RUN,
    )
    const doc = readFileSync(join(root, 'docs/deploy-smoke.md'), 'utf8')
    expect(doc).toContain(failureLine)
    expect(doc).not.toContain('[deploy-smoke] github.sha=')

    const cancelled: SmokeStateFile = {
      outcome: 'running',
      githubSha: SHA,
      workerVersion: VERSION,
      runUrl: RUN,
      step: 'poll-job',
      failedStep: null,
      jobId: null,
      articleId: null,
      lastStage: null,
      errorKind: null,
      missing: [],
      cleanupErrorKind: null,
    }
    const cancelFields = notificationForState(cancelled, {})
    if (cancelFields === null) {
      throw new Error('cancel')
    }
    const cancel = buildSmokeSlackMessage(cancelFields)
    expect(cancel).toBe(
      `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=poll-job errorKind=interrupted lastStage=- jobId=- runUrl=${RUN}`,
    )
    assertFixedLine(
      cancel,
      '[deploy-smoke]',
      ['sha', 'workerVersion', 'failedStep', 'errorKind', 'lastStage', 'jobId', 'runUrl'],
      RUN,
    )
    expect(cancel).not.toContain('cleanupErrorKind')
    expect(cancel).not.toContain(SMOKE_PHRASE)

    const withCleanup = buildSmokeSlackMessage({
      githubSha: SHA,
      workerVersion: VERSION,
      failedStep: 'poll-job',
      jobId: JOB,
      lastStage: 'fetch',
      errorKind: 'timeout',
      cleanupErrorKind: 'http_503',
      runUrl: RUN,
    })
    expect(withCleanup).toBe(
      `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=poll-job errorKind=timeout lastStage=fetch jobId=${JOB} runUrl=${RUN} cleanupErrorKind=http_503`,
    )
    assertFixedLine(
      withCleanup,
      '[deploy-smoke]',
      ['sha', 'workerVersion', 'failedStep', 'errorKind', 'lastStage', 'jobId', 'runUrl', 'cleanupErrorKind'],
      RUN,
    )

    const withoutCleanup = buildSmokeSlackMessage({
      githubSha: SHA,
      workerVersion: VERSION,
      failedStep: 'poll-job',
      jobId: JOB,
      lastStage: 'fetch',
      errorKind: 'timeout',
      cleanupErrorKind: null,
      runUrl: RUN,
    })
    expect(withoutCleanup).toBe(
      `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=poll-job errorKind=timeout lastStage=fetch jobId=${JOB} runUrl=${RUN}`,
    )
    expect(withoutCleanup).not.toContain('cleanupErrorKind')
    assertFixedLine(
      withoutCleanup,
      '[deploy-smoke]',
      ['sha', 'workerVersion', 'failedStep', 'errorKind', 'lastStage', 'jobId', 'runUrl'],
      RUN,
    )
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

  it('lists missing config names in the warning and summary and fails only when SMOKE_REQUIRED is truthy', async () => {
    for (const value of [undefined, '', '  ', 'false', 'no', '0', 'on', 'yesplease', `true ${TOKEN}`]) {
      expect(isSmokeRequired(value), JSON.stringify(value)).toBe(false)
    }
    for (const value of ['true', 'TRUE', ' True ', '1', ' 1 ', 'yes', 'YES', ' Yes ']) {
      expect(isSmokeRequired(value), JSON.stringify(value)).toBe(true)
    }

    const result = await runDeploySmoke({
      settings: settings({ opdsUsername: '', opdsPassword: '   ' }),
      fetch: vi.fn(async () => new Response('no')),
      log: () => {},
    })
    expect(result.kind).toBe('skipped')
    if (result.kind !== 'skipped') {
      return
    }
    expect(result.state.outcome).toBe('skipped')
    expect(result.missing).toEqual(['SMOKE_OPDS_USERNAME', 'SMOKE_OPDS_PASSWORD'])

    const poisoned = [
      ...result.missing,
      TOKEN,
      PASS,
      USER,
      WEBHOOK,
      `${TOKEN.slice(0, 8)}`,
      `SMOKE_CLIP_TOKEN=${TOKEN}`,
      'smoke_opds_username',
    ]
    const dir = mkdtempSync(join(tmpdir(), 'smoke-unset-'))
    const warnings: string[] = []
    const optionalSummary = join(dir, 'optional')
    const optionalExit = publishUnsetSkip({
      missing: poisoned,
      smokeRequired: ' false ',
      summaryPath: optionalSummary,
      warn: (line) => warnings.push(line),
    })
    expect(optionalExit).toBe(0)
    const requiredSummary = join(dir, 'required')
    const requiredExit = publishUnsetSkip({
      missing: poisoned,
      smokeRequired: ' YeS ',
      summaryPath: requiredSummary,
      warn: (line) => warnings.push(line),
    })
    expect(requiredExit).toBe(1)
    expect(publishUnsetSkip({ missing: poisoned, smokeRequired: undefined, warn: (line) => warnings.push(line) })).toBe(0)

    const leakedSummary = join(dir, 'leaked')
    const leakedWarnings: string[] = []
    expect(
      publishUnsetSkip({
        missing: poisoned,
        smokeRequired: `true ${TOKEN}`,
        summaryPath: leakedSummary,
        warn: (line) => leakedWarnings.push(line),
      }),
    ).toBe(0)
    const optionalText = `${warnings[0]}\n${readFileSync(optionalSummary, 'utf8')}`
    const requiredText = `${warnings[1]}\n${readFileSync(requiredSummary, 'utf8')}`
    const leakedText = `${leakedWarnings.join('\n')}\n${readFileSync(leakedSummary, 'utf8')}`
    for (const text of [optionalText, requiredText, leakedText, unsetSmokeNotice(poisoned, true).summary]) {
      expect(text).toContain('SMOKE_OPDS_USERNAME')
      expect(text).toContain('SMOKE_OPDS_PASSWORD')
      expect(text).not.toContain('SMOKE_CLIP_TOKEN')
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(PASS)
      expect(text).not.toContain(USER)
      expect(text).not.toContain(WEBHOOK)
      expect(text).not.toContain(TOKEN.slice(0, 8))
      expect(text).not.toContain('smoke_opds_username')
      expect(text).not.toContain('SMOKE_CLIP_TOKEN=')
    }
    expect(readFileSync(optionalSummary, 'utf8')).not.toContain('=')
    expect(readFileSync(requiredSummary, 'utf8')).not.toContain('=')
    expect(warnings[0]).toBe('::warning title=未設定::未設定: SMOKE_OPDS_USERNAME, SMOKE_OPDS_PASSWORD')
    expect(warnings[0]).not.toContain('\n')
    expect(readFileSync(optionalSummary, 'utf8')).toContain('未設定のため skip しました。')
    expect(readFileSync(optionalSummary, 'utf8')).not.toContain('失敗')
    expect(readFileSync(requiredSummary, 'utf8')).toContain('`SMOKE_OPDS_USERNAME`')
    expect(readFileSync(requiredSummary, 'utf8')).toContain('`SMOKE_OPDS_PASSWORD`')
    expect(readFileSync(requiredSummary, 'utf8')).toContain('SMOKE_REQUIRED')
    expect(readFileSync(requiredSummary, 'utf8')).not.toContain('YeS')
    expect(readFileSync(requiredSummary, 'utf8')).not.toContain('yes')

    const articleNotice = unsetSmokeNotice(['SMOKE_ARTICLE_URL', ARTICLE, 'SMOKE_ORIGIN'], false)
    expect(articleNotice.names).toEqual(['SMOKE_ARTICLE_URL', 'SMOKE_ORIGIN'])
    expect(articleNotice.annotation).toBe('::warning title=未設定::未設定: SMOKE_ARTICLE_URL, SMOKE_ORIGIN')
    expect(articleNotice.summary).toContain('`SMOKE_ARTICLE_URL`')
    expect(articleNotice.summary).toContain('`SMOKE_ORIGIN`')
    expect(`${articleNotice.annotation}\n${articleNotice.summary}`).not.toContain(ARTICLE)
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

  it('classifies preflight timeouts without reading the error message', () => {
    expect(preflightTransportErrorKind(new TypeError(`timeout ${ARTICLE} ${MARKER}`))).toBe('network')
    const timeout = new Error(`The operation was aborted ${ARTICLE} ${MARKER}`)
    timeout.name = 'TimeoutError'
    expect(preflightTransportErrorKind(timeout)).toBe('timeout')
    expect(preflightTransportErrorKind({ name: 'AbortError', code: 23, message: ARTICLE })).toBe('timeout')
    expect(preflightTransportErrorKind({ name: 'TypeError', message: ARTICLE, cause: timeout })).toBe('timeout')
    expect(preflightTransportErrorKind({ name: 'TypeError', code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe('timeout')
    expect(preflightStatusErrorKind(404)).toBe('http_404')
    expect(preflightStatusErrorKind(503)).toBe('http_503')
    expect(preflightStatusErrorKind(599)).toBe('http_599')
    expect(preflightStatusErrorKind(99)).toBe('network')
    const poisoned = articleUnreachableSummary(`${TOKEN} ${ARTICLE} ${MARKER}`)
    expect(poisoned).not.toContain(TOKEN)
    expect(poisoned).not.toContain(ARTICLE)
    expect(poisoned).not.toContain(MARKER)
    expect(poisoned).not.toContain('未設定')
    expect(poisoned).toContain('errorKind=-')
    expect(SMOKE_PREFLIGHT_RETRY_DELAY_MS).toBe(12_000)
    expect(SMOKE_PREFLIGHT_RETRY_DELAY_MS).toBeGreaterThanOrEqual(10_000)
    expect(SMOKE_PREFLIGHT_RETRY_DELAY_MS).toBeLessThanOrEqual(15_000)
  })

  it('uses different log and job summary reasons for an unset URL and an unreachable article', async () => {
    const unsetLogs: string[] = []
    const unsetFetch = vi.fn(async () => new Response(MARKER, { status: 404 }))
    const unset = await runDeploySmoke({
      settings: settings({ articleUrl: 'not a url' }),
      fetch: unsetFetch,
      log: (line) => unsetLogs.push(line),
      preflightRetryDelayMs: 0,
    })
    expect(unset.kind).toBe('skipped')
    if (unset.kind !== 'skipped') {
      return
    }
    expect(unset.state.outcome).toBe('skipped')
    expect(unset.missing).toEqual(['SMOKE_ARTICLE_URL'])
    const unsetText = unsetLogs.join('\n')
    expect(unsetText).toContain('未設定: SMOKE_ARTICLE_URL')
    expect(unsetText).not.toContain('article-preflight')
    expect(unsetText).not.toContain('届きませんでした')
    expect(unsetFetch).not.toHaveBeenCalled()
    assertNoLeak(unsetText)

    const originLogs: string[] = []
    const originFetch = vi.fn(async () => new Response(MARKER, { status: 404 }))
    const origin = await runDeploySmoke({
      settings: settings({ origin: 'https://example.com/not-an-origin' }),
      fetch: originFetch,
      log: (line) => originLogs.push(line),
      preflightRetryDelayMs: 0,
    })
    expect(origin.kind).toBe('skipped')
    if (origin.kind !== 'skipped') {
      return
    }
    expect(origin.missing).toEqual(['SMOKE_ORIGIN'])
    expect(originLogs.join('\n')).toContain('未設定: SMOKE_ORIGIN')
    expect(originLogs.join('\n')).not.toContain('article-preflight')
    expect(originFetch).not.toHaveBeenCalled()

    const dir = mkdtempSync(join(tmpdir(), 'smoke-unset-reach-'))
    const unsetOff = join(dir, 'unset-off')
    const unsetOn = join(dir, 'unset-on')
    const unsetWarnings: string[] = []
    expect(
      recordDeploySmokeResult({
        result: unset,
        smokeRequired: 'false',
        summaryPath: unsetOff,
        warn: (line) => unsetWarnings.push(line),
      }),
    ).toBe(0)
    expect(
      recordDeploySmokeResult({
        result: unset,
        smokeRequired: 'true',
        summaryPath: unsetOn,
        warn: (line) => unsetWarnings.push(line),
      }),
    ).toBe(1)
    expect(
      recordDeploySmokeResult({
        result: origin,
        smokeRequired: undefined,
        summaryPath: join(dir, 'origin-off'),
      }),
    ).toBe(0)
    expect(
      recordDeploySmokeResult({
        result: origin,
        smokeRequired: 'yes',
        summaryPath: join(dir, 'origin-on'),
      }),
    ).toBe(1)
    const unsetOffText = `${unsetWarnings[0]}\n${readFileSync(unsetOff, 'utf8')}`
    const unsetOnText = `${unsetWarnings[1]}\n${readFileSync(unsetOn, 'utf8')}`
    expect(unsetOffText).toContain('未設定: SMOKE_ARTICLE_URL')
    expect(unsetOffText).toContain('未設定のため skip しました。')
    expect(unsetOnText).toContain('未設定のためジョブを失敗にしました。')
    expect(unsetOnText).toContain('SMOKE_REQUIRED')
    for (const text of [unsetOffText, unsetOnText, readFileSync(join(dir, 'origin-on'), 'utf8')]) {
      expect(text).toContain('未設定')
      expect(text).not.toContain('届きませんでした')
      expect(text).not.toContain('article-preflight')
      expect(text).not.toContain(MARKER)
      assertNoLeak(text)
    }

    const downLogs: string[] = []
    const downCalls: string[] = []
    const down = await runDeploySmoke({
      settings: settings(),
      preflightRetryDelayMs: 0,
      sleep: async () => {},
      now: () => NOW,
      log: (line) => downLogs.push(line),
      fetch: async (input, init) => {
        downCalls.push(`${init?.method ?? 'GET'} ${requestTarget(input)}`)
        return new Response(`${MARKER} ${ARTICLE} ${TOKEN} ${SMOKE_PHRASE}`, { status: 404 })
      },
    })
    expect(down.kind).toBe('failed')
    if (down.kind !== 'failed') {
      return
    }
    expect(down.state.outcome).toBe('failed')
    expect(down.state.failedStep).toBe('article-preflight')
    expect(down.state.errorKind).toBe('http_404')
    expect(down.state.missing).toEqual([])
    expect(downCalls).toEqual([`GET ${ARTICLE}`, `GET ${ARTICLE}`])
    const downText = downLogs.join('\n')
    expect(downText).not.toContain('未設定')
    expect(downText).not.toContain('SMOKE_ARTICLE_URL')
    expect(downText).toContain('article-preflight retry errorKind=http_404')
    expect(downText).toContain('failed step=article-preflight errorKind=http_404')
    expect(downText).not.toContain(MARKER)
    assertNoLeak(downText)

    const downWarnings: string[] = []
    for (const required of ['false', 'true', undefined] as const) {
      const summaryPath = join(dir, `down-${required ?? 'missing'}`)
      expect(
        recordDeploySmokeResult({
          result: down,
          smokeRequired: required,
          summaryPath,
          warn: (line) => downWarnings.push(line),
        }),
      ).toBe(1)
      const summary = readFileSync(summaryPath, 'utf8')
      expect(summary).toContain('記事に届きませんでした。failedStep=article-preflight errorKind=http_404')
      expect(summary).not.toContain('未設定')
      expect(summary).not.toContain('SMOKE_ARTICLE_URL')
      expect(summary).not.toContain('SMOKE_REQUIRED')
      expect(summary).not.toContain(MARKER)
      assertNoLeak(summary)
    }
    expect(downWarnings).toEqual([])

    const notify = vi.fn(async (_message: string) => {})
    expect(await notifyIfSmokeFailed(down, notify)).toBe(true)
    const message = notify.mock.calls[0]?.[0] ?? ''
    expect(message).toBe(
      `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=article-preflight errorKind=http_404 lastStage=- jobId=- runUrl=${RUN}`,
    )
    assertFixedLine(
      message,
      '[deploy-smoke]',
      ['sha', 'workerVersion', 'failedStep', 'errorKind', 'lastStage', 'jobId', 'runUrl'],
      RUN,
    )
    expect(message).not.toContain('未設定')
    expect(message).not.toContain(MARKER)
    assertNoLeak(message)
    const fields = notificationForState(down.state, {})
    if (fields === null) {
      throw new Error('fields')
    }
    expect(buildSmokeSlackMessage(fields)).toBe(message)
    await expectNoDelete(down.state)
    await expectNoArticleRollback(down.state)

    const pagesLogs: string[] = []
    const pagesCalls: string[] = []
    const pages = await runDeploySmoke({
      settings: settings({ articleUrl: '' }),
      preflightRetryDelayMs: 0,
      sleep: async () => {},
      log: (line) => pagesLogs.push(line),
      fetch: async (input) => {
        pagesCalls.push(requestTarget(input))
        return new Response(`${MARKER} ${DEFAULT_SMOKE_ARTICLE_URL}`, { status: 404 })
      },
    })
    expect(pages.kind).toBe('failed')
    if (pages.kind !== 'failed') {
      return
    }
    expect(pages.state.failedStep).toBe('article-preflight')
    expect(pages.state.errorKind).toBe('http_404')
    expect(pagesCalls).toEqual([DEFAULT_SMOKE_ARTICLE_URL, DEFAULT_SMOKE_ARTICLE_URL])
    const pagesText = pagesLogs.join('\n')
    expect(pagesText).not.toContain('未設定')
    expect(pagesText).not.toContain('github.io')
    expect(pagesText).not.toContain(MARKER)
    assertNoLeak(pagesText)
    expect(
      recordDeploySmokeResult({
        result: pages,
        smokeRequired: 'true',
        summaryPath: join(dir, 'pages'),
      }),
    ).toBe(1)
    expect(readFileSync(join(dir, 'pages'), 'utf8')).toContain('errorKind=http_404')
    expect(readFileSync(join(dir, 'pages'), 'utf8')).not.toContain('未設定')
  })

  it('retries an unreachable article once, then continues when a fetch succeeds', async () => {
    const failures: Array<{
      readonly name: string
      readonly errorKind: string
      readonly respond: () => Promise<Response>
    }> = [
      {
        name: 'http_500',
        errorKind: 'http_500',
        respond: async () => new Response(`${MARKER} ${ARTICLE}`, { status: 500 }),
      },
      {
        name: 'http_403',
        errorKind: 'http_403',
        respond: async () => new Response(MARKER, { status: 403 }),
      },
      {
        name: 'network',
        errorKind: 'network',
        respond: async () => {
          throw new TypeError(`connect ECONNREFUSED ${ARTICLE} ${MARKER}`)
        },
      },
      {
        name: 'timeout',
        errorKind: 'timeout',
        respond: async () => {
          const error = new Error(`aborted ${ARTICLE} ${MARKER}`)
          error.name = 'TimeoutError'
          throw error
        },
      },
    ]
    for (const failure of failures) {
      const logs: string[] = []
      const calls: string[] = []
      const sleeps: number[] = []
      const result = await runDeploySmoke({
        settings: settings(),
        preflightRetryDelayMs: 0,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        now: () => NOW,
        log: (line) => logs.push(line),
        fetch: async (input, init) => {
          calls.push(`${init?.method ?? 'GET'} ${requestTarget(input)}`)
          return failure.respond()
        },
      })
      expect(result.kind, failure.name).toBe('failed')
      if (result.kind !== 'failed') {
        continue
      }
      expect(result.state.failedStep, failure.name).toBe('article-preflight')
      expect(result.state.errorKind, failure.name).toBe(failure.errorKind)
      expect(calls, failure.name).toEqual([`GET ${ARTICLE}`, `GET ${ARTICLE}`])
      expect(sleeps, failure.name).toEqual([0])
      const text = logs.join('\n')
      expect(text, failure.name).not.toContain('未設定')
      expect(text, failure.name).toContain(`article-preflight retry errorKind=${failure.errorKind}`)
      expect(text, failure.name).toContain(`failed step=article-preflight errorKind=${failure.errorKind}`)
      expect(text, failure.name).not.toContain(MARKER)
      assertNoLeak(text)
      const summaryPath = join(mkdtempSync(join(tmpdir(), 'smoke-reach-')), 'summary')
      expect(recordDeploySmokeResult({ result, smokeRequired: 'false', summaryPath }), failure.name).toBe(1)
      expect(recordDeploySmokeResult({ result, smokeRequired: ' YES ', summaryPath: `${summaryPath}-on` }), failure.name).toBe(1)
      const summary = readFileSync(summaryPath, 'utf8')
      expect(summary, failure.name).toContain(`errorKind=${failure.errorKind}`)
      expect(summary, failure.name).not.toContain('未設定')
      expect(summary, failure.name).not.toContain(MARKER)
      assertNoLeak(summary)
      const notify = vi.fn(async (_message: string) => {})
      expect(await notifyIfSmokeFailed(result, notify), failure.name).toBe(true)
      const message = notify.mock.calls[0]?.[0] ?? ''
      expect(message, failure.name).toContain('failedStep=article-preflight')
      expect(message, failure.name).toContain(`errorKind=${failure.errorKind}`)
      expect(message, failure.name).not.toContain('未設定')
      expect(message, failure.name).not.toContain(MARKER)
      assertNoLeak(message)
      await expectNoDelete(result.state)
      await expectNoArticleRollback(result.state)
    }

    const mixedLogs: string[] = []
    let mixedGets = 0
    const mixedSleeps: number[] = []
    const mixed = await runDeploySmoke({
      settings: settings(),
      preflightRetryDelayMs: 0,
      sleep: async (ms) => {
        mixedSleeps.push(ms)
      },
      now: () => NOW,
      log: (line) => mixedLogs.push(line),
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? 'GET'
        if (url === ARTICLE && method === 'GET') {
          mixedGets += 1
          if (mixedGets === 1) {
            const error = new Error(`aborted ${ARTICLE} ${MARKER}`)
            error.name = 'TimeoutError'
            throw error
          }
          return new Response(`${MARKER} ${TOKEN}`, { status: 500 })
        }
        throw new Error(`unexpected ${method} ${url}`)
      },
    })
    expect(mixedGets).toBe(2)
    expect(mixedSleeps).toEqual([0])
    expect(mixed.kind).toBe('failed')
    if (mixed.kind === 'failed') {
      expect(mixed.state.errorKind).toBe('http_500')
      expect(mixed.state.failedStep).toBe('article-preflight')
    }
    expect(mixedLogs.join('\n')).toContain('article-preflight retry errorKind=timeout')
    expect(mixedLogs.join('\n')).toContain('failed step=article-preflight errorKind=http_500')
    expect(mixedLogs.join('\n')).not.toContain('未設定')
    expect(mixedLogs.join('\n')).not.toContain(MARKER)
    assertNoLeak(mixedLogs.join('\n'))

    const defaultSleeps: number[] = []
    let defaultGets = 0
    await runDeploySmoke({
      settings: settings(),
      sleep: async (ms) => {
        defaultSleeps.push(ms)
      },
      now: () => NOW,
      log: () => {},
      fetch: async (input) => {
        if (requestTarget(input) === ARTICLE) {
          defaultGets += 1
          return new Response(MARKER, { status: 404 })
        }
        throw new Error('unexpected')
      },
    })
    expect(defaultGets).toBe(2)
    expect(defaultSleeps).toEqual([SMOKE_PREFLIGHT_RETRY_DELAY_MS])

    let readyGets = 0
    let posts = 0
    const readySleeps: number[] = []
    const readyLogs: string[] = []
    const ready = await runDeploySmoke({
      settings: settings(),
      preflightRetryDelayMs: 7,
      sleep: async (ms) => {
        readySleeps.push(ms)
      },
      now: () => NOW,
      log: (line) => readyLogs.push(line),
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? 'GET'
        if (url === ARTICLE && method === 'GET') {
          readyGets += 1
          if (readyGets === 1) {
            return new Response(MARKER, { status: 503 })
          }
          return new Response(HTML, { status: 200 })
        }
        if (method === 'POST') {
          posts += 1
          return new Response(MARKER, { status: 500 })
        }
        throw new Error(`unexpected ${method} ${url}`)
      },
    })
    expect(readyGets).toBe(2)
    expect(posts).toBe(1)
    expect(readySleeps).toEqual([7])
    expect(ready.kind).toBe('failed')
    if (ready.kind === 'failed') {
      expect(ready.state.failedStep).toBe('post-clip')
      expect(ready.state.errorKind).toBe('http_500')
    }
    expect(readyLogs.join('\n')).toContain('article-preflight retry errorKind=http_503')
    expect(readyLogs.join('\n')).not.toContain('未設定')
    expect(readyLogs.join('\n')).not.toContain(MARKER)
    assertNoLeak(readyLogs.join('\n'))

    let firstGets = 0
    const firstSleeps: number[] = []
    const first = await runDeploySmoke({
      settings: settings(),
      preflightRetryDelayMs: 0,
      sleep: async (ms) => {
        firstSleeps.push(ms)
      },
      now: () => NOW,
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? 'GET'
        if (url === ARTICLE && method === 'GET') {
          firstGets += 1
          return new Response(HTML, { status: 200 })
        }
        if (method === 'POST') {
          return new Response('no', { status: 500 })
        }
        throw new Error(`unexpected ${method} ${url}`)
      },
    })
    expect(firstGets).toBe(1)
    expect(firstSleeps).toEqual([])
    expect(first.kind).toBe('failed')
    if (first.kind === 'failed') {
      expect(first.state.failedStep).toBe('post-clip')
    }

    const phraseLogs: string[] = []
    let phraseGets = 0
    const phraseSleeps: number[] = []
    const phrase = await runDeploySmoke({
      settings: settings(),
      preflightRetryDelayMs: 0,
      sleep: async (ms) => {
        phraseSleeps.push(ms)
      },
      now: () => NOW,
      log: (line) => phraseLogs.push(line),
      fetch: async (input) => {
        phraseGets += 1
        return new Response(`no phrase ${MARKER} ${ARTICLE}`, { status: 200 })
      },
    })
    expect(phraseGets).toBe(1)
    expect(phraseSleeps).toEqual([])
    expect(phrase.kind).toBe('failed')
    if (phrase.kind !== 'failed') {
      return
    }
    expect(phrase.state.failedStep).toBe('article-preflight')
    expect(phrase.state.errorKind).toBe('phrase_missing')
    expect(phraseLogs.join('\n')).not.toContain('未設定')
    expect(phraseLogs.join('\n')).not.toContain('retry')
    expect(phraseLogs.join('\n')).not.toContain(MARKER)
    assertNoLeak(phraseLogs.join('\n'))
    const phraseSummary = join(mkdtempSync(join(tmpdir(), 'smoke-phrase-')), 'summary')
    expect(recordDeploySmokeResult({ result: phrase, smokeRequired: 'false', summaryPath: phraseSummary })).toBe(1)
    expect(recordDeploySmokeResult({ result: phrase, smokeRequired: 'true', summaryPath: `${phraseSummary}-on` })).toBe(1)
    expect(existsSync(phraseSummary)).toBe(false)
    expect(existsSync(`${phraseSummary}-on`)).toBe(false)
    await expectNoDelete(phrase.state)
    await expectNoArticleRollback(phrase.state)
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
    expect(message).toBe(
      `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=poll-job errorKind=timeout lastStage=fetch jobId=${JOB} runUrl=${RUN} cleanupErrorKind=http_503`,
    )
    assertNoLeak(message)
    expect(message).not.toContain(ARTICLE)
    expect(message).not.toContain(SMOKE_PHRASE)

    const deleteOnly = notificationForState({ ...failed, outcome: 'passed', failedStep: null, errorKind: null }, {})
    if (deleteOnly === null) {
      throw new Error('deleteOnly')
    }
    expect(deleteOnly.failedStep).toBe('delete')
    expect(deleteOnly.errorKind).toBe('http_503')
    expect(deleteOnly.cleanupErrorKind).toBeUndefined()
    expect(buildSmokeSlackMessage(deleteOnly)).toBe(
      `[deploy-smoke] sha=${SHA} workerVersion=${VERSION} failedStep=delete errorKind=http_503 lastStage=fetch jobId=${JOB} runUrl=${RUN}`,
    )
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
    expect(smokeJob).toContain('SMOKE_REQUIRED: ${{ vars.SMOKE_REQUIRED }}')
    expect(smokeJob).not.toContain('secrets.SMOKE_REQUIRED')
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
    expect(doc).toContain('SMOKE_REQUIRED')
    expect(doc).toContain('warning annotation')
    expect(doc).toContain('job summary')
    expect(doc).toContain('記事に届きませんでした。failedStep=article-preflight errorKind=http_404')
    expect(doc).toContain('12 秒')
    expect(doc).toContain('が無効でもジョブは失敗する')
    expect(doc).not.toContain('不正または届かないとき')
    expect(doc).not.toContain('届かないあいだスモークは `未設定: SMOKE_ARTICLE_URL`')
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
