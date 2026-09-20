import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { clipJobIdFromUrl, isClipJobId, parseHttpUrl, type ClipJobId } from '../types/id.ts'
import { PIPELINE_STAGES, type PipelineStage } from '../types/http.ts'

export type PipelineLogEvent = {
  readonly jobId?: string
  readonly runId?: string
  readonly attempt?: number
  readonly articleId?: string
  readonly stage: PipelineStage
  readonly durationMs: number
  readonly errorKind?: string
}

type ClipJobViewBase = {
  readonly jobId: string
  readonly sourceUrl: string
}

export type ClipJobView =
  | (ClipJobViewBase & {
      readonly status: 'queued' | 'running'
      readonly attempt: number
    })
  | (ClipJobViewBase & {
      readonly status: 'ready'
      readonly id: string
      readonly epubPath: string
    })
  | (ClipJobViewBase & {
      readonly status: 'failed'
      readonly error: { readonly code: string; readonly message: string }
    })

export type ClipJobSnapshot =
  | { readonly kind: 'job'; readonly body: ClipJobView }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'skipped'; readonly reason: string }

export type ClipStatusArgs = {
  readonly target: string
  readonly tail: boolean
  readonly stdin: boolean
}

export const CLIP_STATUS_USAGE = `使い方: npm run clip:status -- [--tail | --stdin] <jobId|url>

環境変数:
  CLIP_TOKEN      GET /clip/jobs/:jobId の Bearer。引数や URL には載せない
  CLIP_BASE_URL   Worker origin（末尾スラッシュなし。WORKER でも可。既定: http://localhost:8787）

--tail    本番の wrangler tail を読み、工程ログを整形する
--stdin   wrangler tail --format json の出力を標準入力から読む

ライブログは接続後だけ見える。接続前の工程は「不明」（未実行や停止とは限らない）。
過去ログの検索・保存、管理画面、Workflows は使わない。最終状態は job API で補う。`

const STAGE_SET: ReadonlySet<string> = new Set(PIPELINE_STAGES)

type WritableTarget = { write(chunk: string): void }

export type ClipStatusIo = {
  readonly argv: readonly string[]
  readonly env: NodeJS.Dict<string>
  readonly stdin: Readable
  readonly stdout: WritableTarget
  readonly stderr: WritableTarget
  readonly stdinIsTTY: boolean
  readonly fetch: typeof fetch
  readonly spawnTail?: (jobId: string) => TailProcess
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export type TailProcess = {
  readonly stdout: Readable
  readonly kill: () => void
  readonly exit: Promise<number | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && STAGE_SET.has(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseClipStatusArgs(
  argv: readonly string[],
): ClipStatusArgs | { readonly error: string } {
  let tail = false
  let stdin = false
  const positionals: string[] = []
  for (const arg of argv) {
    if (arg === '--tail') {
      tail = true
      continue
    }
    if (arg === '--stdin') {
      stdin = true
      continue
    }
    if (arg.startsWith('-')) {
      return { error: `不明なオプション: ${arg}\n\n${CLIP_STATUS_USAGE}` }
    }
    positionals.push(arg)
  }
  if (tail && stdin) {
    return { error: `--tail と --stdin は同時に使えない\n\n${CLIP_STATUS_USAGE}` }
  }
  const target = positionals[0]
  if (target === undefined || positionals.length !== 1) {
    return { error: CLIP_STATUS_USAGE }
  }
  return { target, tail, stdin }
}

export async function resolveClipJobId(
  target: string,
): Promise<ClipJobId | { readonly error: string }> {
  if (isClipJobId(target)) {
    return target
  }
  const url = parseHttpUrl(target)
  if (url === null) {
    return { error: `jobId または http(s) URL を指定する: ${target}` }
  }
  return clipJobIdFromUrl(url)
}

export function workerBaseUrl(env: NodeJS.Dict<string>): string {
  const raw = env.CLIP_BASE_URL ?? env.WORKER ?? 'http://localhost:8787'
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

function parsePipelineEvent(value: unknown): PipelineLogEvent | null {
  if (!isRecord(value) || value.event !== 'pipeline' || !isPipelineStage(value.stage)) {
    return null
  }
  if (!isFiniteNumber(value.durationMs)) {
    return null
  }
  return {
    stage: value.stage,
    durationMs: value.durationMs,
    ...(typeof value.jobId === 'string' ? { jobId: value.jobId } : {}),
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    ...(isFiniteNumber(value.attempt) ? { attempt: value.attempt } : {}),
    ...(typeof value.articleId === 'string' ? { articleId: value.articleId } : {}),
    ...(typeof value.errorKind === 'string' ? { errorKind: value.errorKind } : {}),
  }
}

function eventsFromUnknown(value: unknown): PipelineLogEvent[] {
  const direct = parsePipelineEvent(value)
  if (direct !== null) {
    return [direct]
  }
  if (!isRecord(value) || !Array.isArray(value.logs)) {
    return []
  }
  return value.logs.flatMap((item) => {
    if (!isRecord(item) || !('message' in item)) {
      return []
    }
    const text = Array.isArray(item.message) ? item.message.map(String).join(' ') : String(item.message)
    const nested = parseJson(text)
    return nested === undefined ? [] : eventsFromUnknown(nested)
  })
}

export function parseLogLine(line: string): PipelineLogEvent[] {
  const trimmed = line.trim()
  if (trimmed === '') {
    return []
  }
  const parsed = parseJson(trimmed)
  return parsed === undefined ? [] : eventsFromUnknown(parsed)
}

export function eventsForJob(
  events: readonly PipelineLogEvent[],
  jobId: string,
): PipelineLogEvent[] {
  return events.filter((event) => event.jobId === jobId)
}

function parseClipJobView(value: unknown): ClipJobView | null {
  if (!isRecord(value) || typeof value.jobId !== 'string' || typeof value.sourceUrl !== 'string') {
    return null
  }
  const base = { jobId: value.jobId, sourceUrl: value.sourceUrl }
  if (
    (value.status === 'queued' || value.status === 'running') &&
    typeof value.attempt === 'number'
  ) {
    return { ...base, status: value.status, attempt: value.attempt }
  }
  if (value.status === 'ready' && typeof value.id === 'string' && typeof value.epubPath === 'string') {
    return { ...base, status: 'ready', id: value.id, epubPath: value.epubPath }
  }
  if (
    value.status === 'failed' &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  ) {
    return {
      ...base,
      status: 'failed',
      error: { code: value.error.code, message: value.error.message },
    }
  }
  return null
}

export async function fetchClipJobSnapshot(input: {
  readonly baseUrl: string
  readonly token: string | undefined
  readonly jobId: string
  readonly fetch: typeof fetch
}): Promise<ClipJobSnapshot> {
  if (!input.token) {
    return { kind: 'skipped', reason: 'CLIP_TOKEN が無い' }
  }
  try {
    const response = await input.fetch(`${input.baseUrl}/clip/jobs/${input.jobId}`, {
      headers: { authorization: `Bearer ${input.token}` },
    })
    if (response.status === 401) {
      return { kind: 'unauthorized' }
    }
    if (response.status === 404) {
      return { kind: 'missing' }
    }
    if (!response.ok) {
      return { kind: 'unavailable', reason: `HTTP ${response.status}` }
    }
    const view = parseClipJobView(await response.json())
    if (view === null) {
      return { kind: 'unavailable', reason: 'job JSON を解釈できない' }
    }
    return { kind: 'job', body: view }
  } catch {
    return { kind: 'unavailable', reason: `${input.baseUrl} に接続できない` }
  }
}

export function inferDisplayStatus(
  job: ClipJobSnapshot,
  events: readonly PipelineLogEvent[],
): string {
  if (job.kind === 'unauthorized') {
    return '不明（認証失敗）'
  }
  if (job.kind === 'missing') {
    return '不明（job なし）'
  }
  if (job.kind !== 'job') {
    return `不明（${job.reason}）`
  }
  switch (job.body.status) {
    case 'ready':
      return '完了'
    case 'failed':
      return '失敗'
    case 'queued':
      return '待機中'
    case 'running': {
      const last = events.at(-1)
      if (last === undefined) {
        return '処理中（工程不明）'
      }
      return last.errorKind === undefined ? '処理中' : '再試行待ち'
    }
  }
}

function attemptLabel(event: PipelineLogEvent): string {
  return event.attempt === undefined ? '-' : String(event.attempt)
}

function latestByStage(
  events: readonly PipelineLogEvent[],
): Map<PipelineStage, PipelineLogEvent> {
  const latest = new Map<PipelineStage, PipelineLogEvent>()
  for (const event of events) {
    latest.set(event.stage, event)
  }
  return latest
}

function formatStageRow(event: PipelineLogEvent | undefined): string {
  if (event === undefined) {
    return `${'不明'.padEnd(8)}${'-'.padEnd(10)}${'-'.padEnd(6)}-`
  }
  const status = event.errorKind === undefined ? '完了' : '失敗'
  return `${status.padEnd(8)}${`${event.durationMs}ms`.padEnd(10)}${attemptLabel(event).padEnd(6)}${event.errorKind ?? '-'}`
}

export function formatEventLine(event: PipelineLogEvent): string {
  return `  ${event.stage.padEnd(10)}${`${event.durationMs}ms`.padEnd(10)}attempt ${attemptLabel(event).padEnd(4)}${event.errorKind ?? 'ok'}`
}

function headerAttempt(job: ClipJobSnapshot, events: readonly PipelineLogEvent[]): string {
  if (job.kind === 'job' && (job.body.status === 'queued' || job.body.status === 'running')) {
    return String(job.body.attempt)
  }
  const attempts = events.flatMap((event) => (event.attempt === undefined ? [] : [event.attempt]))
  return attempts.length === 0 ? '不明' : String(Math.max(...attempts))
}

export function formatClipStatus(input: {
  readonly jobId: string
  readonly job: ClipJobSnapshot
  readonly events: readonly PipelineLogEvent[]
}): string {
  const matched = eventsForJob(input.events, input.jobId)
  const body = input.job.kind === 'job' ? input.job.body : undefined
  const lines = [
    `jobId    ${input.jobId}`,
    `対象     ${body?.sourceUrl ?? '不明'}`,
    `状態     ${inferDisplayStatus(input.job, matched)}`,
    `試行     ${headerAttempt(input.job, matched)}`,
  ]
  if (body?.status === 'ready') {
    lines.push(`記事     ${body.id}`, `EPUB     ${body.epubPath}`)
  }
  if (body?.status === 'failed') {
    lines.push(`失敗     ${body.error.code}: ${body.error.message}`)
  }
  lines.push('', `${'工程'.padEnd(10)}${'状態'.padEnd(8)}${'所要'.padEnd(10)}${'試行'.padEnd(6)}失敗`)
  const latest = latestByStage(matched)
  for (const stage of PIPELINE_STAGES) {
    lines.push(`${stage.padEnd(10)}${formatStageRow(latest.get(stage))}`)
  }
  if (matched.length > 0) {
    lines.push('', 'イベント', ...matched.map(formatEventLine))
  }
  lines.push(
    '',
    'ライブログに無い工程は「不明」です。未実行や停止とは限りません。過去ログは保存しません。',
  )
  return lines.join('\n')
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).then(
    () => undefined,
    () => undefined,
  )
}

function wranglerBin(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/wrangler')
}

export function spawnWranglerTail(jobId: string): TailProcess {
  const child = spawn(wranglerBin(), ['tail', '--format', 'json', '--search', jobId], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return {
    stdout: child.stdout ?? Readable.from([]),
    kill() {
      child.kill()
    },
    exit: new Promise((resolve) => {
      child.once('exit', resolve)
    }),
  }
}

async function readLogLines(
  input: Readable,
  onEvent: (event: PipelineLogEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const rl = createInterface({
    input,
    crlfDelay: Infinity,
    ...(signal === undefined ? {} : { signal }),
  })
  try {
    for await (const line of rl) {
      for (const event of parseLogLine(String(line))) {
        onEvent(event)
      }
    }
  } catch (cause) {
    if (signal?.aborted !== true) {
      throw cause
    }
  }
}

function jobIsTerminal(job: ClipJobSnapshot): boolean {
  return job.kind === 'job' && (job.body.status === 'ready' || job.body.status === 'failed')
}

function canPollJob(job: ClipJobSnapshot): boolean {
  return job.kind === 'job' && (job.body.status === 'queued' || job.body.status === 'running')
}

function writeError(io: ClipStatusIo, message: string): 1 {
  io.stderr.write(`${message}\n`)
  return 1
}

async function followTail(input: {
  readonly io: ClipStatusIo
  readonly jobId: string
  readonly job: ClipJobSnapshot
  readonly loadJob: () => Promise<ClipJobSnapshot>
  readonly events: PipelineLogEvent[]
}): Promise<ClipJobSnapshot> {
  let job = input.job
  const ac = new AbortController()
  const tail = (input.io.spawnTail ?? spawnWranglerTail)(input.jobId)
  const sleep = input.io.sleep ?? defaultSleep
  const stop = () => {
    ac.abort()
    tail.kill()
  }
  void tail.exit.then((code) => {
    ac.abort()
    if (code !== 0 && code !== null && !jobIsTerminal(job) && input.events.length === 0) {
      input.io.stderr.write('wrangler tail が終了した。npx wrangler login を確認する\n')
    }
  })
  const waitForJob = async () => {
    if (!canPollJob(job)) {
      return
    }
    while (!ac.signal.aborted) {
      await sleep(2000, ac.signal)
      if (ac.signal.aborted) {
        return
      }
      job = await input.loadJob()
      if (!canPollJob(job)) {
        await sleep(500, ac.signal)
        stop()
        return
      }
    }
  }
  await Promise.all([
    readLogLines(
      tail.stdout,
      (event) => {
        if (event.jobId !== input.jobId) {
          return
        }
        input.events.push(event)
        input.io.stdout.write(`${formatEventLine(event)}\n`)
      },
      ac.signal,
    ).finally(stop),
    waitForJob(),
  ])
  return canPollJob(job) || job.kind === 'skipped' ? input.loadJob() : job
}

export async function runClipStatus(io: ClipStatusIo): Promise<number> {
  const parsed = parseClipStatusArgs(io.argv)
  if ('error' in parsed) {
    return writeError(io, parsed.error)
  }
  const jobId = await resolveClipJobId(parsed.target)
  if (typeof jobId !== 'string') {
    return writeError(io, jobId.error)
  }

  const loadJob = () =>
    fetchClipJobSnapshot({
      baseUrl: workerBaseUrl(io.env),
      token: io.env.CLIP_TOKEN,
      jobId,
      fetch: io.fetch,
    })

  let job = await loadJob()
  if (job.kind === 'unauthorized') {
    return writeError(io, 'CLIP_TOKEN が Worker と一致しない（Bearer。引数には渡さない）')
  }

  const events: PipelineLogEvent[] = []
  const collect = (event: PipelineLogEvent) => {
    if (event.jobId === jobId) {
      events.push(event)
    }
  }
  const printReport = () => {
    io.stdout.write(`${formatClipStatus({ jobId, job, events })}\n`)
  }

  if (parsed.stdin) {
    if (io.stdinIsTTY) {
      return writeError(
        io,
        '標準入力が空です。`npx wrangler tail --format json` をパイプするか --tail を使う',
      )
    }
    await readLogLines(io.stdin, collect)
    job = await loadJob()
    printReport()
    return 0
  }

  if (!parsed.tail) {
    printReport()
    return 0
  }

  if (job.kind === 'missing') {
    printReport()
    return writeError(io, 'job が無い。CLIP_BASE_URL と jobId を確認する')
  }
  if (job.kind === 'unavailable') {
    printReport()
    return writeError(io, `最終状態を取得できない: ${job.reason}`)
  }
  if (jobIsTerminal(job)) {
    printReport()
    io.stderr.write(
      'すでに完了または失敗しているので wrangler tail は起動しない（過去ログは取れない）\n',
    )
    return 0
  }

  printReport()
  io.stdout.write('\nライブログ:\n')
  job = await followTail({ io, jobId, job, loadJob, events })
  io.stdout.write('\n')
  printReport()
  return 0
}

async function main(): Promise<void> {
  process.exitCode = await runClipStatus({
    argv: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    fetch,
  })
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main()
}
