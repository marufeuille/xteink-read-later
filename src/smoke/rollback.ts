import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { isDeployNotification, joinNotificationLine, sanitizeGithubSha, sanitizeKind, sanitizeRunUrl, sanitizeStep, sanitizeWorkerVersion } from './message.ts'
import { parseWorkerDeploymentVersion } from './worker-version.ts'

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const GIT_SHA = /^[0-9a-f]{40}$/
const RESULT = /^(?:rolled_back|rollback_failed|skipped:[a-z][a-z0-9_]{0,40})$/
const ROLLBACK_MESSAGE = /^deploy-rollback sha=(?:[0-9a-f]{40}|unknown) run=(?:\d{1,20}|-)$/
const WORKER_SCRIPT = 'xteink-read-later'
/** Shorter than the 12 minute rollback step, so notify still runs if verify hangs. */
export const VERIFY_DEADLINE_MS = 9 * 60 * 1000
const STDERR_HEAD = /^[A-Za-z0-9 .,;:_[\]()'"/+-]{1,120}$/
const NOTE = /^[a-z][a-z0-9_]{0,40}$/

/** Fixed token. Means main still has the change and a revert PR is needed. No deploy data is interpolated. */
export const ROLLBACK_REVERT_NOTE = 'revert_pr_needed'

/**
 * Top-level wrangler keys that are bindings or triggers.
 * compatibility_date, observability, and limits are intentionally absent:
 * a code-looking smoke failure may still roll those back with the version.
 */
export const WRANGLER_BINDING_OR_TRIGGER_KEYS = [
  'agent_memory',
  'ai',
  'ai_search',
  'ai_search_namespaces',
  'analytics_engine_datasets',
  'artifacts',
  'browser',
  'connect',
  'containers',
  'd1_databases',
  'dispatch_namespaces',
  'durable_objects',
  'flagship',
  'hyperdrive',
  'images',
  'kv_namespaces',
  'logfwdr',
  'media',
  'migrations',
  'mtls_certificates',
  'pipelines',
  'queues',
  'r2_buckets',
  'ratelimits',
  'route',
  'routes',
  'secrets',
  'secrets_store_secrets',
  'send_email',
  'services',
  'stream',
  'streaming_tail_consumers',
  'tail_consumers',
  'triggers',
  'unsafe',
  'vars',
  'vectorize',
  'version_metadata',
  'vpc_networks',
  'vpc_services',
  'worker_loaders',
  'workflows',
] as const

export type RollbackVerify = 'verified' | 'still_failing' | '-'

export type DeployDiff = {
  readonly paths: readonly string[]
  readonly wranglerBefore: string | null
  readonly wranglerAfter: string | null
  readonly diffKnown: boolean
}

export type RollbackContext = {
  readonly jobResult: string
  readonly outcome: string
  readonly failedStep: string
  readonly errorKind: string
  readonly cleanupErrorKind: string
  readonly previousWorkerVersion: string
  readonly workerVersion: string
  readonly githubSha: string
  readonly runUrl: string
  readonly runId: string
}

export type SmokeRollbackClass =
  | { readonly kind: 'ignore'; readonly reason: 'passed' | 'skip' }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'candidate' }

export type RollbackRunResult = {
  readonly exitCode: number
  readonly result: string
  readonly verify: RollbackVerify
  readonly notified: boolean
  readonly rolledBack: boolean
  readonly message: string | null
}

type SmokeOutputState = {
  readonly outcome: string
  readonly failedStep: string | null
  readonly errorKind: string | null
  readonly cleanupErrorKind: string | null
}

const OUTCOMES = new Set(['running', 'skipped', 'failed', 'passed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function present(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== '' && trimmed !== '-'
}

function isHttp5xx(kind: string): boolean {
  return kind === 'http_5xx' || /^http_5\d\d$/.test(kind)
}

/** Ops allowlist. Anything else is notify-only. `http_5xx` matches `http_500`–`http_599`. */
export function isCodeLookingFailure(failedStep: string, errorKind: string): boolean {
  switch (failedStep) {
    case 'post-clip':
      return isHttp5xx(errorKind)
    case 'poll-job':
      return errorKind === 'extract_failed' || errorKind === 'epub_failed' || errorKind === 'internal_error'
    case 'opds-catalog':
      return errorKind === 'not_in_catalog' || isHttp5xx(errorKind)
    case 'download-epub':
      return isHttp5xx(errorKind)
    case 'verify-epub':
      return /^epub_[a-z0-9_]+$/.test(errorKind)
    default:
      return false
  }
}

export function classifySmokeForRollback(input: {
  readonly jobResult: string
  readonly outcome: string
  readonly failedStep: string
  readonly errorKind: string
  readonly cleanupErrorKind: string
}): SmokeRollbackClass {
  const job = input.jobResult.trim().toLowerCase()
  const outcome = input.outcome.trim().toLowerCase()
  const step = input.failedStep.trim().toLowerCase()
  const kind = input.errorKind.trim().toLowerCase()
  const cleanup = input.cleanupErrorKind.trim().toLowerCase()

  if (job === 'cancelled' || outcome === 'cancelled') {
    return { kind: 'skip', reason: 'cancelled' }
  }
  if (outcome === 'skipped' || job === 'skipped') {
    return { kind: 'ignore', reason: 'skip' }
  }
  if (outcome === 'passed' || step === 'delete') {
    if (step === 'delete' || present(cleanup)) {
      return { kind: 'skip', reason: 'delete' }
    }
    return { kind: 'ignore', reason: 'passed' }
  }
  if (outcome !== 'failed') {
    if (job === 'failure' && (outcome === 'running' || kind === 'interrupted')) {
      return { kind: 'skip', reason: 'external' }
    }
    if (job === 'failure') {
      return { kind: 'skip', reason: 'not_allowlisted' }
    }
    return { kind: 'ignore', reason: 'passed' }
  }
  if (step === 'article-preflight') {
    return { kind: 'skip', reason: 'preflight' }
  }
  if (step === 'poll-job' && kind === 'timeout') {
    return { kind: 'skip', reason: 'timeout' }
  }
  if (
    kind === 'network' ||
    kind === 'fetch_failed' ||
    kind === 'http_401' ||
    kind === 'http_403' ||
    kind === 'interrupted'
  ) {
    return { kind: 'skip', reason: 'external' }
  }
  if (!isCodeLookingFailure(step, kind)) {
    return { kind: 'skip', reason: 'not_allowlisted' }
  }
  return { kind: 'candidate' }
}

function knownVersion(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (!VERSION_ID.test(normalized)) {
    return null
  }
  return normalized
}

export function diffHasMigrations(paths: readonly string[]): boolean {
  return paths.some((path) => /(^|\/)migrations\//.test(path.replaceAll('\\', '/')))
}

function wranglerConfigPath(path: string): boolean {
  return /(?:^|\/)wrangler\.(?:jsonc|json|toml)$/.test(path.replaceAll('\\', '/'))
}

function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index] ?? ''
    const next = input[index + 1] ?? ''
    if (inString) {
      out += current
      if (escape) {
        escape = false
      } else if (current === '\\') {
        escape = true
      } else if (current === '"') {
        inString = false
      }
      continue
    }
    if (current === '"') {
      inString = true
      out += current
      continue
    }
    if (current === '/' && next === '/') {
      index += 1
      while (index + 1 < input.length && input[index + 1] !== '\n') {
        index += 1
      }
      continue
    }
    if (current === '/' && next === '*') {
      index += 2
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        index += 1
      }
      index += 1
      continue
    }
    out += current
  }
  return out
}

function parseJsonc(text: string): unknown {
  const stripped = stripJsonComments(text).replace(/,\s*([}\]])/g, '$1')
  return JSON.parse(stripped) as unknown
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item))
  }
  if (!isRecord(value)) {
    return value
  }
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortValue(value[key])
  }
  return sorted
}

function pickBindings(config: unknown): unknown {
  if (!isRecord(config)) {
    return null
  }
  const picked: Record<string, unknown> = {}
  for (const key of WRANGLER_BINDING_OR_TRIGGER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      picked[key] = config[key]
    }
  }
  if (Object.prototype.hasOwnProperty.call(config, 'env')) {
    const env = config.env
    if (isRecord(env)) {
      const nested: Record<string, unknown> = {}
      for (const name of Object.keys(env).sort()) {
        nested[name] = pickBindings(env[name])
      }
      picked.env = nested
    } else {
      picked.env = env
    }
  }
  return picked
}

export function bindingsOrTriggersChanged(diff: DeployDiff): boolean {
  const configPath = diff.paths.find((path) => wranglerConfigPath(path))
  if (configPath === undefined) {
    return false
  }
  if (diff.wranglerBefore === null || diff.wranglerAfter === null) {
    return true
  }
  if (configPath.endsWith('.toml')) {
    return diff.wranglerBefore !== diff.wranglerAfter
  }
  try {
    const before = JSON.stringify(sortValue(pickBindings(parseJsonc(diff.wranglerBefore))))
    const after = JSON.stringify(sortValue(pickBindings(parseJsonc(diff.wranglerAfter))))
    return before !== after
  } catch {
    return true
  }
}

export function guardRollbackCandidate(input: {
  readonly previousWorkerVersion: string
  readonly workerVersion: string
  readonly liveWorkerVersion: string
  readonly diff: DeployDiff
}): { readonly action: 'rollback'; readonly to: string } | { readonly action: 'skip'; readonly reason: string } {
  const previous = knownVersion(input.previousWorkerVersion)
  const worker = knownVersion(input.workerVersion)
  if (previous === null || worker === null) {
    return { action: 'skip', reason: 'unknown_version' }
  }
  if (previous === worker) {
    return { action: 'skip', reason: 'same_version' }
  }
  if (!input.diff.diffKnown) {
    return { action: 'skip', reason: 'unknown_diff' }
  }
  if (diffHasMigrations(input.diff.paths) || bindingsOrTriggersChanged(input.diff)) {
    return { action: 'skip', reason: 'migration' }
  }
  const live = knownVersion(input.liveWorkerVersion)
  if (live === null || live !== worker) {
    return { action: 'skip', reason: 'version_mismatch' }
  }
  return { action: 'rollback', to: previous }
}

function versionField(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '-') {
    return '-'
  }
  return sanitizeWorkerVersion(trimmed)
}

function sanitizeResult(value: string): string {
  return RESULT.test(value) ? value : 'skipped:unknown'
}

function sanitizeVerify(value: string): RollbackVerify {
  if (value === 'verified' || value === 'still_failing') {
    return value
  }
  return '-'
}

export function rollbackAnnotation(sha: string, runId: string): string {
  const safeSha = sanitizeGithubSha(sha)
  const safeRun = /^\d{1,20}$/.test(runId.trim()) ? runId.trim() : '-'
  return `deploy-rollback sha=${safeSha} run=${safeRun}`
}

export type RollbackSlackFields = {
  readonly githubSha: string
  readonly fromVersion: string
  readonly toVersion: string
  readonly failedStep: string
  readonly errorKind: string
  readonly result: string
  readonly verify: string
  readonly runUrl: string
}

function sanitizeNote(value: string): string {
  if (!NOTE.test(value)) {
    throw new Error('rollback note rejected')
  }
  return value
}

/**
 * One line. Key order: sha, from, to, trigger, result, verify, runUrl,
 * then note only when the result is rolled_back.
 * Missing to and verify are `-`. Only those fields are interpolated.
 */
export function buildRollbackSlackMessage(input: RollbackSlackFields): string {
  const result = sanitizeResult(input.result)
  const fields: Array<readonly [string, string]> = [
    ['sha', sanitizeGithubSha(input.githubSha)],
    ['from', versionField(input.fromVersion)],
    ['to', versionField(input.toVersion)],
    ['trigger', `${sanitizeStep(input.failedStep)}/${sanitizeKind(input.errorKind)}`],
    ['result', result],
    ['verify', sanitizeVerify(input.verify)],
    ['runUrl', sanitizeRunUrl(input.runUrl)],
  ]
  if (result === 'rolled_back') {
    fields.push(['note', sanitizeNote(ROLLBACK_REVERT_NOTE)])
  }
  const message = joinNotificationLine('[deploy-rollback]', fields)
  if (!isDeployNotification(message)) {
    throw new Error('rollback message rejected')
  }
  return message
}

export function wranglerRollbackInvocation(
  versionId: string,
  message: string,
  cwd = process.cwd(),
): { readonly command: string; readonly args: readonly string[] } {
  if (!VERSION_ID.test(versionId.trim().toLowerCase())) {
    throw new Error('rollback version id required')
  }
  if (message.length === 0 || message.length > 120 || !ROLLBACK_MESSAGE.test(message)) {
    throw new Error('rollback message rejected')
  }
  return {
    command: join(cwd, 'node_modules', '.bin', 'wrangler'),
    args: ['rollback', versionId.trim().toLowerCase(), '--message', message, '--yes'],
  }
}

export type RollbackAttempt = {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly stderrHead: string | null
}

/**
 * First stderr line, only when it cannot hold a token, URL, or secret.
 * ANSI and a leading error mark are removed. Anything else is dropped.
 */
export function safeStderrHead(stderr: string): string | null {
  const plain = stderr.replace(/\u001b\[[0-9;]*m/g, '')
  const line = plain
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (line === undefined) {
    return null
  }
  const clipped = line.replace(/^[✘×]\s*/, '').slice(0, 120)
  if (!STDERR_HEAD.test(clipped)) {
    return null
  }
  if (/https?:\/\/|@|bearer|token|secret|password|authorization|api[_-]?key|=/i.test(clipped)) {
    return null
  }
  if (/[A-Za-z0-9+/_-]{20,}/.test(clipped)) {
    return null
  }
  return clipped
}

function exitCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null
  }
  const status = error.status
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 255) {
    return null
  }
  return status
}

function stderrOf(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return ''
  }
  const stderr = error.stderr
  if (typeof stderr === 'string') {
    return stderr
  }
  if (stderr instanceof Uint8Array) {
    return new TextDecoder().decode(stderr)
  }
  return ''
}

/** Exit code plus a token-free stderr head. Does not include the raw error. */
export function rollbackCommandFailure(error: unknown): Pick<RollbackAttempt, 'exitCode' | 'stderrHead'> {
  return {
    exitCode: exitCodeOf(error),
    stderrHead: safeStderrHead(stderrOf(error)),
  }
}

/**
 * Runs wrangler. Stdout is discarded.
 * On failure, returns the exit code and a stderr head that cannot contain a token.
 */
export function runWranglerRollback(versionId: string, message: string): RollbackAttempt {
  const invocation = wranglerRollbackInvocation(versionId, message)
  try {
    execFileSync(invocation.command, [...invocation.args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_WRITE_LOGS: 'false',
      },
    })
    return { ok: true, exitCode: 0, stderrHead: null }
  } catch (error) {
    return { ok: false, ...rollbackCommandFailure(error) }
  }
}

export function smokeResultOutputs(state: SmokeOutputState | null): {
  readonly outcome: string
  readonly failedStep: string
  readonly errorKind: string
  readonly cleanupErrorKind: string
} {
  if (state === null) {
    return { outcome: 'unknown', failedStep: '-', errorKind: '-', cleanupErrorKind: '-' }
  }
  return {
    outcome: OUTCOMES.has(state.outcome) ? state.outcome : 'unknown',
    failedStep: state.failedStep === null ? '-' : sanitizeStep(state.failedStep),
    errorKind: state.errorKind === null ? '-' : sanitizeKind(state.errorKind),
    cleanupErrorKind: state.cleanupErrorKind === null ? '-' : sanitizeKind(state.cleanupErrorKind),
  }
}

export function formatGithubOutput(name: string, value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name)) {
    throw new Error('output name rejected')
  }
  return `${name}=${value.replace(/[\r\n]/g, '')}\n`
}

function emptyUnknownDiff(): DeployDiff {
  return { paths: [], wranglerBefore: null, wranglerAfter: null, diffKnown: false }
}

function gitShow(spec: string, cwd: string): string | null {
  try {
    return execFileSync('git', ['show', spec], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * Diff from the SHA that produced the live version to this deploy.
 * `github.event.before` is not that SHA. An unreadable base fails closed.
 */
export function readDeployDiff(before: string, head: string, cwd = process.cwd()): DeployDiff {
  const beforeSha = before.trim().toLowerCase()
  const headSha = head.trim().toLowerCase()
  if (!GIT_SHA.test(beforeSha) || !GIT_SHA.test(headSha) || /^0+$/.test(beforeSha)) {
    return emptyUnknownDiff()
  }
  try {
    const names = execFileSync('git', ['diff', '--name-only', beforeSha, headSha], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const paths = names
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const configPath = paths.find((path) => wranglerConfigPath(path))
    if (configPath === undefined) {
      return { paths, wranglerBefore: null, wranglerAfter: null, diffKnown: true }
    }
    return {
      paths,
      wranglerBefore: gitShow(`${beforeSha}:${configPath}`, cwd),
      wranglerAfter: gitShow(`${headSha}:${configPath}`, cwd),
      diffKnown: true,
    }
  } catch {
    return emptyUnknownDiff()
  }
}

export async function fetchLiveWorkerVersion(input: {
  readonly accountId: string
  readonly apiToken: string
  readonly fetchImpl: typeof fetch
}): Promise<string> {
  if (input.accountId.trim() === '' || input.apiToken.trim() === '') {
    return 'unknown'
  }
  try {
    const response = await input.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId.trim())}/workers/scripts/${WORKER_SCRIPT}/deployments`,
      {
        headers: { authorization: `Bearer ${input.apiToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!response.ok) {
      return 'unknown'
    }
    return parseWorkerDeploymentVersion(await response.json())
  } catch {
    return 'unknown'
  }
}

function triggerOf(context: RollbackContext, reason: string): { readonly failedStep: string; readonly errorKind: string } {
  if (reason === 'delete') {
    return {
      failedStep: 'delete',
      errorKind: present(context.cleanupErrorKind) ? context.cleanupErrorKind : context.errorKind,
    }
  }
  return { failedStep: context.failedStep, errorKind: context.errorKind }
}

function verifyLabel(outcome: 'passed' | 'failed' | 'skipped'): RollbackVerify {
  return outcome === 'passed' ? 'verified' : 'still_failing'
}

function normalizeAttempt(value: boolean | RollbackAttempt): RollbackAttempt {
  if (typeof value === 'boolean') {
    return { ok: value, exitCode: null, stderrHead: null }
  }
  return value
}

function exitLabel(exitCode: number | null): string {
  if (exitCode === null || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    return '-'
  }
  return String(exitCode)
}

async function verifyWithinDeadline(
  verify: () => Promise<'passed' | 'failed' | 'skipped'>,
  deadlineMs: number,
): Promise<'passed' | 'failed' | 'skipped' | 'deadline'> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('deadline'), deadlineMs)
    verify().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve('failed')
      },
    )
  })
}

export async function runDeployRollback(deps: {
  readonly context: RollbackContext
  readonly diff: DeployDiff
  readonly liveWorkerVersion: string
  readonly rollback: (versionId: string, message: string) => Promise<boolean | RollbackAttempt>
  readonly verify: () => Promise<'passed' | 'failed' | 'skipped'>
  readonly notify: (message: string) => Promise<void>
  readonly summarize: (message: string) => void
  readonly log?: (line: string) => void
  readonly verifyDeadlineMs?: number
}): Promise<RollbackRunResult> {
  const smoke = classifySmokeForRollback(deps.context)
  if (smoke.kind === 'ignore') {
    return {
      exitCode: 0,
      result: `skipped:${smoke.reason}`,
      verify: '-',
      notified: false,
      rolledBack: false,
      message: null,
    }
  }

  const guarded = smoke.kind === 'candidate' ? guardRollbackCandidate({
    previousWorkerVersion: deps.context.previousWorkerVersion,
    workerVersion: deps.context.workerVersion,
    liveWorkerVersion: deps.liveWorkerVersion,
    diff: deps.diff,
  }) : { action: 'skip' as const, reason: smoke.reason }

  const annotation = rollbackAnnotation(deps.context.githubSha, deps.context.runId)
  let result = `skipped:${guarded.action === 'skip' ? guarded.reason : 'unknown'}`
  let verify: RollbackVerify = '-'
  let rolledBack = false
  let exitCode = 0

  if (guarded.action === 'rollback') {
    let attempt: RollbackAttempt = { ok: false, exitCode: null, stderrHead: null }
    try {
      attempt = normalizeAttempt(await deps.rollback(guarded.to, annotation))
    } catch (error) {
      attempt = { ok: false, ...rollbackCommandFailure(error) }
    }
    if (!attempt.ok) {
      result = 'rollback_failed'
      exitCode = 1
      const stderrHead = attempt.stderrHead === null ? null : safeStderrHead(attempt.stderrHead)
      deps.log?.(`rollback_failed exit=${exitLabel(attempt.exitCode)} stderr=${stderrHead ?? '-'}`)
    } else {
      rolledBack = true
      const verified = await verifyWithinDeadline(deps.verify, deps.verifyDeadlineMs ?? VERIFY_DEADLINE_MS)
      verify = verified === 'deadline' ? '-' : verifyLabel(verified)
      result = 'rolled_back'
    }
  }

  const trigger = triggerOf(deps.context, guarded.action === 'skip' ? guarded.reason : '')
  const message = buildRollbackSlackMessage({
    githubSha: deps.context.githubSha,
    fromVersion: deps.context.workerVersion,
    toVersion: guarded.action === 'rollback' ? guarded.to : '-',
    failedStep: trigger.failedStep,
    errorKind: trigger.errorKind,
    result,
    verify,
    runUrl: deps.context.runUrl,
  })
  deps.summarize(message)
  deps.log?.(message)
  await deps.notify(message)
  return { exitCode, result, verify, notified: true, rolledBack, message }
}
