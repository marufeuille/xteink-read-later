import { setTimeout as delay } from 'node:timers/promises'
import { articleIdFromCanonicalUrl, isArticleId, parseHttpUrl } from '../types/id.ts'
import {
  DEFAULT_SMOKE_ARTICLE_URL,
  DEFAULT_SMOKE_ORIGIN,
  SMOKE_MAX_CATALOG_BYTES,
  SMOKE_MAX_CATALOG_FETCHES,
  SMOKE_MAX_EPUB_BYTES,
  SMOKE_MAX_PAGE_BYTES,
  SMOKE_MAX_WAIT_MS,
  SMOKE_PHRASE,
  SMOKE_POLL_INTERVAL_MS,
  SMOKE_PREFLIGHT_TIMEOUT_MS,
  SMOKE_SECRET_NAMES,
  type SmokeSecretName,
} from './constants.ts'
import { verifySmokeEpub } from './epub.ts'
import {
  buildSmokeSlackMessage,
  isDeployNotification,
  sanitizeGithubSha,
  sanitizeKind,
  sanitizeRunUrl,
  sanitizeStep,
  sanitizeWorkerVersion,
  type SmokeFailureFields,
} from './message.ts'
import { redactSmokeText } from './redact.ts'

export type SmokeSettings = {
  readonly clipToken?: string
  readonly opdsUsername?: string
  readonly opdsPassword?: string
  readonly slackWebhookUrl?: string
  readonly articleUrl?: string
  readonly origin?: string
  readonly githubSha?: string
  readonly workerVersion?: string
  readonly runUrl?: string
}

export type SmokeStateFile = {
  readonly outcome: 'running' | 'skipped' | 'failed' | 'passed'
  readonly githubSha: string
  readonly workerVersion: string
  readonly runUrl: string
  readonly step: string | null
  readonly failedStep: string | null
  readonly jobId: string | null
  readonly articleId: string | null
  readonly lastStage: string | null
  readonly errorKind: string | null
  readonly missing: readonly string[]
  readonly cleanupErrorKind: string | null
}

export type SmokeRunResult =
  | { readonly kind: 'skipped'; readonly missing: readonly string[]; readonly state: SmokeStateFile }
  | { readonly kind: 'failed'; readonly state: SmokeStateFile }
  | { readonly kind: 'passed'; readonly state: SmokeStateFile }

export type SmokeRunDeps = {
  readonly settings: SmokeSettings
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (line: string) => void
  readonly onProgress?: (state: SmokeStateFile) => void
  readonly maxWaitMs?: number
  readonly pollIntervalMs?: number
}

type JobView = {
  readonly status: string
  readonly articleId: string | null
  readonly lastStage: string | null
  readonly errorKind: string | null
}

const JOB_STATUSES = new Set(['queued', 'running', 'ready', 'failed'])
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,80}$/
const JOB_ID = /^job_[a-f0-9]{32}$/

function configured(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function missingSmokeSecrets(settings: SmokeSettings): SmokeSecretName[] {
  const values: Record<SmokeSecretName, string | undefined> = {
    SMOKE_CLIP_TOKEN: settings.clipToken,
    SMOKE_OPDS_USERNAME: settings.opdsUsername,
    SMOKE_OPDS_PASSWORD: settings.opdsPassword,
    SMOKE_SLACK_WEBHOOK_URL: settings.slackWebhookUrl,
  }
  return SMOKE_SECRET_NAMES.filter((name) => !configured(values[name]))
}

export function resolveSmokeArticleUrl(raw: string | undefined): string | null {
  if (!configured(raw)) {
    return DEFAULT_SMOKE_ARTICLE_URL
  }
  return parseHttpUrl(raw.trim())
}

function resolveOrigin(raw: string | undefined): string | null {
  const value = configured(raw) ? raw.trim() : DEFAULT_SMOKE_ORIGIN
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    return null
  }
  const url = new URL(parsed)
  if (url.pathname !== '/' || url.search !== '' || url.username !== '' || url.password !== '') {
    return null
  }
  return url.origin
}

function blankState(settings: SmokeSettings): SmokeStateFile {
  return {
    outcome: 'running',
    githubSha: sanitizeGithubSha(settings.githubSha),
    workerVersion: sanitizeWorkerVersion(settings.workerVersion),
    runUrl: sanitizeRunUrl(settings.runUrl),
    step: 'record',
    failedStep: null,
    jobId: null,
    articleId: null,
    lastStage: null,
    errorKind: null,
    missing: [],
    cleanupErrorKind: null,
  }
}

function hiddenValues(settings: SmokeSettings, articleUrl: string | null): string[] {
  return [settings.clipToken, settings.opdsUsername, settings.opdsPassword, settings.slackWebhookUrl, articleUrl, SMOKE_PHRASE].filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  )
}

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function tokyoDate(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs))
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.href
  }
  return input.url
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string | null> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    return null
  }
  return new TextDecoder().decode(bytes)
}

function readJobId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('jobId' in value)) {
    return null
  }
  const jobId = value.jobId
  return typeof jobId === 'string' && JOB_ID.test(jobId) ? jobId : null
}

function safeToken(value: unknown): string | null {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : null
}

function parseJob(value: unknown): JobView | null {
  if (typeof value !== 'object' || value === null || !('status' in value) || typeof value.status !== 'string') {
    return null
  }
  if (!JOB_STATUSES.has(value.status)) {
    return null
  }
  let articleId: string | null = null
  if ('id' in value && typeof value.id === 'string' && isArticleId(value.id)) {
    articleId = value.id
  }
  let lastStage: string | null = null
  let stageError: string | null = null
  if ('stages' in value && Array.isArray(value.stages)) {
    for (const stage of value.stages) {
      if (typeof stage !== 'object' || stage === null) {
        continue
      }
      const name = 'stage' in stage ? safeToken(stage.stage) : null
      const errorKind = 'errorKind' in stage ? safeToken(stage.errorKind) : null
      if (name !== null) {
        lastStage = name
      }
      if (errorKind !== null) {
        stageError = errorKind
        if (name !== null) {
          lastStage = name
        }
      }
    }
  }
  let errorKind = stageError
  if ('error' in value && typeof value.error === 'object' && value.error !== null && 'code' in value.error) {
    const code = safeToken(value.error.code)
    if (code !== null) {
      errorKind = code
    }
  }
  return { status: value.status, articleId, lastStage, errorKind }
}

function catalogPath(origin: string, href: string): string | null {
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== new URL(origin).origin) {
    return null
  }
  const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  if (path === '/opds' || path === '/opds/clip' || /^\/opds\/clip\/\d{4}-\d{2}-\d{2}$/.test(path)) {
    return path
  }
  return null
}

function hrefs(xml: string): string[] {
  const found: string[] = []
  for (const match of xml.matchAll(/href="([^"]+)"/g)) {
    const href = match[1]
    if (href !== undefined) {
      found.push(href)
    }
  }
  return found
}

export async function notifyIfSmokeFailed(
  result: SmokeRunResult,
  notify: (message: string) => Promise<void>,
): Promise<boolean> {
  if (result.kind !== 'failed') {
    return false
  }
  await notify(buildSmokeSlackMessage(failureFields(result.state)))
  return true
}

const CLEANUP_STEPS = new Set(['post-clip', 'poll-job', 'opds-catalog', 'download-epub', 'verify-epub'])

/** True when a clip POST may already have been accepted, even if no id was recorded. */
export function smokeMayHavePosted(state: SmokeStateFile | null): boolean {
  if (state === null) {
    return true
  }
  if (state.outcome === 'skipped') {
    return false
  }
  if (state.jobId !== null || state.articleId !== null || state.outcome === 'passed') {
    return true
  }
  const step = state.failedStep ?? state.step
  return step !== null && CLEANUP_STEPS.has(step)
}

export function failureFields(state: SmokeStateFile): SmokeFailureFields {
  return {
    githubSha: state.githubSha,
    workerVersion: state.workerVersion,
    failedStep: state.failedStep ?? state.step ?? 'smoke',
    jobId: state.jobId,
    lastStage: state.lastStage,
    errorKind: state.errorKind,
    runUrl: state.runUrl,
    ...(state.outcome !== 'passed' && state.cleanupErrorKind !== null
      ? { cleanupErrorKind: state.cleanupErrorKind }
      : {}),
  }
}

export async function postSmokeSlack(webhookUrl: string, message: string, fetchImpl: typeof fetch): Promise<void> {
  if (!isDeployNotification(message)) {
    throw new Error('slack message rejected')
  }
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })
  if (!response.ok) {
    throw new Error(`slack HTTP ${response.status}`)
  }
}

export async function runDeploySmoke(deps: SmokeRunDeps): Promise<SmokeRunResult> {
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? delay
  const maxWaitMs = deps.maxWaitMs ?? SMOKE_MAX_WAIT_MS
  const pollIntervalMs = deps.pollIntervalMs ?? SMOKE_POLL_INTERVAL_MS
  const articleUrl = resolveSmokeArticleUrl(deps.settings.articleUrl)
  const hidden = hiddenValues(deps.settings, articleUrl)
  const allowUrls = [sanitizeRunUrl(deps.settings.runUrl)].filter((url) => url !== '-')
  const log = (line: string) => {
    deps.log?.(redactSmokeText(line, hidden, allowUrls))
  }
  let state = blankState(deps.settings)
  const publish = (next: SmokeStateFile) => {
    state = next
    deps.onProgress?.(next)
  }
  publish(state)
  log(`github.sha=${state.githubSha}`)
  log(`workerVersion=${state.workerVersion}`)
  if (state.runUrl !== '-') {
    log(`runUrl=${state.runUrl}`)
  }

  const missing = missingSmokeSecrets(deps.settings)
  if (missing.length > 0) {
    for (const name of missing) {
      log(`未設定: ${name}`)
    }
    const skipped: SmokeStateFile = { ...state, outcome: 'skipped', step: null, missing }
    publish(skipped)
    return { kind: 'skipped', missing, state: skipped }
  }

  if (articleUrl === null) {
    log('未設定: SMOKE_ARTICLE_URL')
    const skipped: SmokeStateFile = { ...state, outcome: 'skipped', step: null, missing: ['SMOKE_ARTICLE_URL'] }
    publish(skipped)
    return { kind: 'skipped', missing: ['SMOKE_ARTICLE_URL'], state: skipped }
  }

  const origin = resolveOrigin(deps.settings.origin)
  if (origin === null) {
    log('未設定: SMOKE_ORIGIN')
    const skipped: SmokeStateFile = { ...state, outcome: 'skipped', step: null, missing: ['SMOKE_ORIGIN'] }
    publish(skipped)
    return { kind: 'skipped', missing: ['SMOKE_ORIGIN'], state: skipped }
  }

  const token = deps.settings.clipToken ?? ''
  const username = deps.settings.opdsUsername ?? ''
  const password = deps.settings.opdsPassword ?? ''
  const bearer = `Bearer ${token}`
  const basic = basicHeader(username, password)

  const fail = (input: {
    readonly failedStep: string
    readonly errorKind: string
    readonly jobId?: string | null
    readonly articleId?: string | null
    readonly lastStage?: string | null
  }): SmokeRunResult => {
    const failed: SmokeStateFile = {
      ...state,
      outcome: 'failed',
      step: input.failedStep,
      failedStep: input.failedStep,
      errorKind: sanitizeKind(input.errorKind) === '-' ? 'failed' : sanitizeKind(input.errorKind),
      jobId: input.jobId === undefined ? state.jobId : input.jobId,
      articleId: input.articleId === undefined ? state.articleId : input.articleId,
      lastStage: input.lastStage === undefined ? state.lastStage : input.lastStage,
    }
    publish(failed)
    log(
      `failed step=${failed.failedStep ?? '-'} errorKind=${failed.errorKind ?? '-'} jobId=${failed.jobId ?? '-'} lastStage=${failed.lastStage ?? '-'}`,
    )
    return { kind: 'failed', state: failed }
  }

  publish({ ...state, step: 'article-preflight' })
  let preflight: Response
  try {
    preflight = await fetchImpl(articleUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(SMOKE_PREFLIGHT_TIMEOUT_MS),
    })
  } catch {
    log('未設定: SMOKE_ARTICLE_URL')
    const skipped: SmokeStateFile = { ...state, outcome: 'skipped', step: null, missing: ['SMOKE_ARTICLE_URL'] }
    publish(skipped)
    return { kind: 'skipped', missing: ['SMOKE_ARTICLE_URL'], state: skipped }
  }
  if (!preflight.ok) {
    log('未設定: SMOKE_ARTICLE_URL')
    const skipped: SmokeStateFile = { ...state, outcome: 'skipped', step: null, missing: ['SMOKE_ARTICLE_URL'] }
    publish(skipped)
    return { kind: 'skipped', missing: ['SMOKE_ARTICLE_URL'], state: skipped }
  }
  const page = await readLimitedText(preflight, SMOKE_MAX_PAGE_BYTES)
  if (page === null) {
    return fail({ failedStep: 'article-preflight', errorKind: 'too_large' })
  }
  if (!page.includes(SMOKE_PHRASE)) {
    return fail({ failedStep: 'article-preflight', errorKind: 'phrase_missing' })
  }

  publish({ ...state, step: 'post-clip' })
  let posted: Response
  try {
    posted = await fetchImpl(`${origin}/clip`, {
      method: 'POST',
      headers: {
        authorization: bearer,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: articleUrl }),
      redirect: 'manual',
    })
  } catch {
    return fail({ failedStep: 'post-clip', errorKind: 'network' })
  }
  if (posted.status !== 202) {
    return fail({ failedStep: 'post-clip', errorKind: `http_${posted.status}` })
  }
  let postedBody: unknown
  try {
    postedBody = await posted.json()
  } catch {
    return fail({ failedStep: 'post-clip', errorKind: 'invalid_response' })
  }
  const jobId = readJobId(postedBody)
  if (jobId === null) {
    return fail({ failedStep: 'post-clip', errorKind: 'invalid_response' })
  }
  publish({ ...state, step: 'poll-job', jobId })
  log(`post-clip jobId=${jobId}`)

  const started = now()
  let articleId: string | null = null
  let lastStage: string | null = null
  for (;;) {
    let polled: Response
    try {
      polled = await fetchImpl(`${origin}/clip/jobs/${jobId}`, {
        headers: { authorization: bearer },
        redirect: 'manual',
      })
    } catch {
      return fail({ failedStep: 'poll-job', errorKind: 'network', jobId, articleId, lastStage })
    }
    if (!polled.ok) {
      return fail({ failedStep: 'poll-job', errorKind: `http_${polled.status}`, jobId, articleId, lastStage })
    }
    let body: unknown
    try {
      body = await polled.json()
    } catch {
      return fail({ failedStep: 'poll-job', errorKind: 'invalid_response', jobId, articleId, lastStage })
    }
    const job = parseJob(body)
    if (job === null) {
      return fail({ failedStep: 'poll-job', errorKind: 'invalid_response', jobId, articleId, lastStage })
    }
    lastStage = job.lastStage
    if (job.articleId !== null) {
      articleId = job.articleId
      publish({ ...state, step: 'poll-job', jobId, articleId, lastStage })
    }
    if (job.status === 'ready') {
      if (job.articleId === null) {
        return fail({ failedStep: 'poll-job', errorKind: 'invalid_response', jobId, articleId, lastStage })
      }
      articleId = job.articleId
      publish({ ...state, step: 'opds-catalog', jobId, articleId, lastStage })
      break
    }
    if (job.status === 'failed') {
      return fail({
        failedStep: 'poll-job',
        errorKind: job.errorKind ?? 'failed',
        jobId,
        articleId,
        lastStage,
      })
    }
    if (now() - started >= maxWaitMs) {
      return fail({ failedStep: 'poll-job', errorKind: 'timeout', jobId, articleId, lastStage })
    }
    const remaining = maxWaitMs - (now() - started)
    await sleep(Math.min(pollIntervalMs, remaining))
  }

  if (articleId === null) {
    return fail({ failedStep: 'poll-job', errorKind: 'invalid_response', jobId, lastStage })
  }

  const listed = await articleInCatalog(fetchImpl, origin, articleId, basic, tokyoDate(now()))
  if (!listed.ok) {
    return fail({ failedStep: 'opds-catalog', errorKind: listed.errorKind, jobId, articleId, lastStage })
  }
  log(`opds-catalog articleId=${articleId}`)

  publish({ ...state, step: 'download-epub', jobId, articleId, lastStage })
  const epub = await downloadEpub(fetchImpl, origin, articleId, basic)
  if (!epub.ok) {
    return fail({ failedStep: 'download-epub', errorKind: epub.errorKind, jobId, articleId, lastStage })
  }
  const verified = verifySmokeEpub(epub.bytes, SMOKE_PHRASE)
  if (!verified.ok) {
    return fail({ failedStep: 'verify-epub', errorKind: verified.errorKind, jobId, articleId, lastStage })
  }
  log('verify-epub ok')
  const passed: SmokeStateFile = {
    ...state,
    outcome: 'passed',
    step: null,
    failedStep: null,
    jobId,
    articleId,
    lastStage,
    errorKind: null,
  }
  publish(passed)
  log('deploy-smoke passed')
  return { kind: 'passed', state: passed }
}

async function articleInCatalog(
  fetchImpl: typeof fetch,
  origin: string,
  articleId: string,
  basic: string,
  date: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorKind: string }> {
  const pending = [`/opds/clip/${date}`, '/opds/clip', '/opds']
  const seen = new Set<string>()
  let fetches = 0
  while (pending.length > 0 && fetches < SMOKE_MAX_CATALOG_FETCHES) {
    const path = pending.shift()
    if (path === undefined || seen.has(path)) {
      continue
    }
    seen.add(path)
    fetches += 1
    let response: Response
    try {
      response = await fetchImpl(`${origin}${path}`, {
        headers: { authorization: basic },
        redirect: 'manual',
      })
    } catch {
      return { ok: false, errorKind: 'network' }
    }
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      return { ok: false, errorKind: `http_${response.status}` }
    }
    if (!response.ok) {
      continue
    }
    const xml = await readLimitedText(response, SMOKE_MAX_CATALOG_BYTES)
    if (xml === null) {
      return { ok: false, errorKind: 'too_large' }
    }
    if (xml.includes(articleId)) {
      return { ok: true }
    }
    for (const href of hrefs(xml)) {
      const next = catalogPath(origin, href)
      if (next !== null && /^\/opds\/clip\/\d{4}-\d{2}-\d{2}$/.test(next) && !seen.has(next)) {
        pending.unshift(next)
      }
    }
  }
  return { ok: false, errorKind: 'not_in_catalog' }
}

async function downloadEpub(
  fetchImpl: typeof fetch,
  origin: string,
  articleId: string,
  basic: string,
): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly errorKind: string }> {
  const paths = [`/opds/download/${articleId}.epub`, `/articles/${articleId}/book.epub`]
  for (const path of paths) {
    let response: Response
    try {
      response = await fetchImpl(`${origin}${path}`, {
        headers: { authorization: basic },
        redirect: 'manual',
      })
    } catch {
      return { ok: false, errorKind: 'network' }
    }
    if (response.status === 404 && path.startsWith('/opds/')) {
      continue
    }
    if (!response.ok) {
      return { ok: false, errorKind: `http_${response.status}` }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > SMOKE_MAX_EPUB_BYTES) {
      return { ok: false, errorKind: 'epub_too_large' }
    }
    return { ok: true, bytes }
  }
  return { ok: false, errorKind: 'http_404' }
}

export async function cleanupSmokeArticle(input: {
  readonly state: SmokeStateFile | null
  readonly settings: SmokeSettings
  readonly fetch?: typeof fetch
  readonly log?: (line: string) => void
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorKind: string }> {
  const fetchImpl = input.fetch ?? fetch
  const articleUrl = resolveSmokeArticleUrl(input.settings.articleUrl)
  const hidden = hiddenValues(input.settings, articleUrl)
  const log = (line: string) => {
    input.log?.(redactSmokeText(line, hidden, []))
  }
  const state = input.state
  if (!smokeMayHavePosted(state)) {
    log('cleanup: nothing to delete')
    return { ok: true }
  }
  if (!configured(input.settings.clipToken)) {
    log('未設定: SMOKE_CLIP_TOKEN')
    return { ok: false, errorKind: 'unset' }
  }
  const ids: string[] = []
  if (state !== null && state.articleId !== null && isArticleId(state.articleId)) {
    ids.push(state.articleId)
  }
  if (articleUrl !== null) {
    const parsed = parseHttpUrl(articleUrl)
    if (parsed !== null) {
      const hashed = await articleIdFromCanonicalUrl(parsed)
      if (!ids.includes(hashed)) {
        ids.push(hashed)
      }
    }
  }
  if (ids.length === 0) {
    log('cleanup: nothing to delete')
    return { ok: true }
  }
  const origin = resolveOrigin(input.settings.origin)
  if (origin === null) {
    return { ok: false, errorKind: 'origin' }
  }
  const token = input.settings.clipToken ?? ''
  for (const id of ids) {
    let response: Response
    try {
      response = await fetchImpl(`${origin}/articles/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
      })
    } catch {
      return { ok: false, errorKind: 'network' }
    }
    if (response.status !== 200 && response.status !== 404) {
      log(`cleanup id=${id} status=${response.status}`)
      return { ok: false, errorKind: `http_${response.status}` }
    }
    log(`cleanup id=${id} status=${response.status}`)
  }
  return { ok: true }
}

export function requestTarget(input: RequestInfo | URL): string {
  return requestUrl(input)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseSmokeState(value: unknown): SmokeStateFile | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (!('outcome' in value)) {
    return null
  }
  const outcome = value.outcome
  if (outcome !== 'running' && outcome !== 'skipped' && outcome !== 'failed' && outcome !== 'passed') {
    return null
  }
  const missing = 'missing' in value && Array.isArray(value.missing) ? value.missing.filter((item) => typeof item === 'string') : []
  return {
    outcome,
    githubSha: 'githubSha' in value && typeof value.githubSha === 'string' ? value.githubSha : 'unknown',
    workerVersion: 'workerVersion' in value && typeof value.workerVersion === 'string' ? value.workerVersion : 'unknown',
    runUrl: 'runUrl' in value && typeof value.runUrl === 'string' ? value.runUrl : '-',
    step: 'step' in value ? stringOrNull(value.step) : null,
    failedStep: 'failedStep' in value ? stringOrNull(value.failedStep) : null,
    jobId: 'jobId' in value ? stringOrNull(value.jobId) : null,
    articleId: 'articleId' in value ? stringOrNull(value.articleId) : null,
    lastStage: 'lastStage' in value ? stringOrNull(value.lastStage) : null,
    errorKind: 'errorKind' in value ? stringOrNull(value.errorKind) : null,
    missing,
    cleanupErrorKind: 'cleanupErrorKind' in value ? stringOrNull(value.cleanupErrorKind) : null,
  }
}

export function notificationForState(
  state: SmokeStateFile | null,
  fallback: { readonly githubSha?: string; readonly workerVersion?: string; readonly runUrl?: string },
): SmokeFailureFields | null {
  if (state === null) {
    return {
      githubSha: fallback.githubSha ?? 'unknown',
      workerVersion: fallback.workerVersion ?? 'unknown',
      failedStep: 'smoke',
      jobId: null,
      lastStage: null,
      errorKind: 'failed',
      runUrl: fallback.runUrl ?? '-',
    }
  }
  if (state.outcome === 'failed' || state.outcome === 'running') {
    const fields = failureFields(state)
    return state.outcome === 'running' && fields.errorKind === null ? { ...fields, errorKind: 'interrupted' } : fields
  }
  if (state.outcome === 'passed' && state.cleanupErrorKind !== null) {
    return {
      ...failureFields(state),
      failedStep: 'delete',
      errorKind: state.cleanupErrorKind,
    }
  }
  return null
}
