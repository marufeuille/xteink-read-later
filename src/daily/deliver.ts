import { reevaluateCandidate } from '../candidates/recommend'
import { workerPublicOrigin } from '../digest/confirm-link'
import { digestSourceInterestPrior, joinDigestInterest } from '../digest/interest'
import { logDailyDigest, type DailyDigestErrorKind, type DailyDigestStage } from '../log'
import { createD1CandidateStore } from '../store/d1-candidates'
import { createD1DigestStore } from '../store/d1-digest'
import { createR2Store } from '../store/r2'
import {
  DIGEST_LIST_PAGE_SIZE,
  DIGEST_MAX_JEV_CALLS,
  digestSummaryCharBudget,
  type ArticleStore,
  type CandidateArticle,
  type CandidateId,
  type CandidateStore,
  type DigestPreparedItem,
  type DigestPublishedItem,
  type DigestQueueMessage,
  type DigestQueueStep,
  type DigestRunResult,
  type DigestStore,
  type FetchPage,
} from '../types'
import { DIGEST_STEP_STALE_MS, DIGEST_WATCHDOG_DELAY_SECONDS, isFinalDigestAttempt } from './budget'
import type { RunDailyDigestDeps } from './deps'
import { parseDailyDate } from './identity'
import { buildDailyDigestWrite } from './issue'
import { publishLatestDaily, unpublishDailyDigests } from './publish'
import {
  createR2DigestRunStore,
  newDigestRunId,
  isDigestRunId,
  type DigestEvalRef,
  type DigestRunLoaded,
  type DigestRunPhase,
  type DigestRunRecord,
  type DigestRunStore,
} from './run-store'
import {
  digestNeedsEvaluation,
  digestSelectionSaturated,
  digestSourceAtCap,
  digestSourceKey,
  orderDigestEvaluations,
  selectDigestCandidates,
} from './select'
import { summarizeDigestArticle } from './summarize'

const STEPS: readonly DigestQueueStep[] = ['start', 'plan', 'evaluate', 'summarize', 'publish', 'watchdog']

export type DigestEnqueue = {
  readonly body: DigestQueueMessage
  readonly delaySeconds?: number
}

export type DigestDeliveryOutcome = {
  readonly action: 'ack' | 'retry'
  readonly enqueue: readonly DigestEnqueue[]
  readonly finished: DigestRunResult | null
  /**
   * Terminal status this delivery newly recorded (`published`, `empty`, or `failed`).
   * Messages that only observe an already finished run leave this null.
   */
  readonly decided: DigestRunResult | null
}

type NormalizedMessage =
  | { readonly date: string; readonly step: 'start' }
  | { readonly date: string; readonly step: 'plan' | 'evaluate' | 'summarize'; readonly runId: string; readonly cursor: number }
  | { readonly date: string; readonly step: 'publish' | 'watchdog'; readonly runId: string }

type DeliveryContext = {
  readonly env: Cloudflare.Env
  readonly deps: RunDailyDigestDeps
  readonly runStore: DigestRunStore
  readonly attempts: number
  readonly scheduleWatchdog: boolean
  readonly now: () => Date
  readonly fetchPage: FetchPage
  readonly store: ArticleStore
  readonly candidateStore: CandidateStore
  readonly digestStore: DigestStore
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDigestStep(value: string): value is DigestQueueStep {
  return (STEPS as readonly string[]).includes(value)
}

function ack(finished: DigestRunResult | null = null, decided: DigestRunResult | null = null): DigestDeliveryOutcome {
  return { action: 'ack', enqueue: [], finished, decided }
}

function retry(decided: DigestRunResult | null = null): DigestDeliveryOutcome {
  return { action: 'retry', enqueue: [], finished: null, decided }
}

export function parseDigestQueueMessage(body: unknown): NormalizedMessage | null {
  if (!isRecord(body) || typeof body.date !== 'string') {
    return null
  }
  const date = parseDailyDate(body.date)
  if (date === null) {
    return null
  }
  const stepValue = body.step === undefined ? 'start' : body.step
  if (typeof stepValue !== 'string' || !isDigestStep(stepValue)) {
    return null
  }
  const step = stepValue
  if (step === 'start') {
    return { date, step: 'start' }
  }
  if (typeof body.runId !== 'string' || !isDigestRunId(body.runId)) {
    return null
  }
  if (step === 'publish' || step === 'watchdog') {
    return { date, step, runId: body.runId }
  }
  if (typeof body.cursor !== 'number' || !Number.isInteger(body.cursor) || body.cursor < 0) {
    return null
  }
  return { date, step, runId: body.runId, cursor: body.cursor }
}

function storeFor(env: Cloudflare.Env, deps: RunDailyDigestDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  return (deps.createStore ?? createR2Store)(env)
}

function candidateStoreFor(env: Cloudflare.Env, deps: RunDailyDigestDeps): CandidateStore {
  if (deps.candidateStore !== undefined) {
    return deps.candidateStore
  }
  return (deps.createCandidateStore ?? createD1CandidateStore)(env)
}

function digestStoreFor(env: Cloudflare.Env, deps: RunDailyDigestDeps): DigestStore {
  if (deps.digestStore !== undefined) {
    return deps.digestStore
  }
  return (deps.createDigestStore ?? createD1DigestStore)(env)
}

function runStoreFor(env: Cloudflare.Env, deps: RunDailyDigestDeps): DigestRunStore {
  return deps.runStore ?? createR2DigestRunStore(env)
}

function elapsedMs(record: DigestRunRecord, now: Date): number {
  const started = Date.parse(record.startedAt)
  if (Number.isNaN(started)) {
    return 0
  }
  return Math.max(0, now.getTime() - started)
}

function logRunning(record: DigestRunRecord, stage: DailyDigestStage, now: Date, attempt: number): void {
  logDailyDigest({
    date: record.date,
    status: 'running',
    stage,
    selected: record.selectedIds.length,
    summarized: record.prepared.length,
    skipped: record.skipped,
    durationMs: elapsedMs(record, now),
    qrCount: record.qrCount,
    attempt,
  })
}

function logTerminal(
  record: DigestRunRecord,
  now: Date,
  attempt: number,
  stage: DailyDigestStage | undefined,
  errorKind: DailyDigestErrorKind | undefined,
): void {
  if (record.status === 'running') {
    return
  }
  logDailyDigest({
    date: record.date,
    status: record.status,
    selected: record.selectedIds.length,
    summarized: record.prepared.length,
    skipped: record.skipped,
    durationMs: elapsedMs(record, now),
    qrCount: record.qrCount,
    attempt,
    ...(record.articleId === null ? {} : { articleId: record.articleId }),
    ...(stage === undefined || record.status !== 'failed' ? {} : { stage }),
    ...(errorKind === undefined ? {} : { errorKind }),
  })
}

function toResult(record: DigestRunRecord): DigestRunResult {
  if (record.status === 'running') {
    return {
      date: record.date,
      status: 'failed',
      selected: record.selectedIds.length,
      summarized: record.prepared.length,
      skipped: record.skipped,
      articleId: null,
      qrCount: 0,
    }
  }
  return {
    date: record.date,
    status: record.status,
    selected: record.selectedIds.length,
    summarized: record.prepared.length,
    skipped: record.skipped,
    articleId: record.articleId,
    qrCount: record.qrCount,
  }
}

function messageFor(record: DigestRunRecord): DigestEnqueue {
  const date = record.date
  const runId = record.runId
  if (record.phase === 'plan') {
    return { body: { date, step: 'plan', runId, cursor: record.planOffset } }
  }
  if (record.phase === 'evaluate') {
    return { body: { date, step: 'evaluate', runId, cursor: record.evalIndex } }
  }
  if (record.phase === 'summarize') {
    return { body: { date, step: 'summarize', runId, cursor: record.summarizeIndex } }
  }
  return { body: { date, step: 'publish', runId } }
}

function watchdogMessage(record: DigestRunRecord): DigestEnqueue {
  return {
    body: { date: record.date, step: 'watchdog', runId: record.runId },
    delaySeconds: DIGEST_WATCHDOG_DELAY_SECONDS,
  }
}

async function save(
  store: DigestRunStore,
  record: DigestRunRecord,
  etag: string,
): Promise<DigestRunLoaded | null> {
  const wrote = await store.put(record, etag)
  if (!wrote.ok) {
    return null
  }
  return { record, etag: wrote.etag }
}

async function listPage(store: CandidateStore, offset: number) {
  return store.listListed({ limit: DIGEST_LIST_PAGE_SIZE, offset })
}

async function listAllListed(store: CandidateStore): Promise<CandidateArticle[]> {
  const items: CandidateArticle[] = []
  let offset = 0
  for (;;) {
    const page = await listPage(store, offset)
    items.push(...page.items)
    offset += page.items.length
    if (page.items.length === 0 || offset >= page.total) {
      return items
    }
  }
}

function publishedHistory(date: string, items: readonly DigestPreparedItem[]): DigestPublishedItem[] {
  return items.map((item) => ({
    date,
    candidateId: item.candidateId,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
  }))
}

function digestQrInput(env: Cloudflare.Env): { readonly publicOrigin: string; readonly secret: string } | undefined {
  const publicOrigin = workerPublicOrigin(env.PUBLIC_ORIGIN)
  const secret = typeof env.CLIP_TOKEN === 'string' ? env.CLIP_TOKEN : ''
  if (publicOrigin === null || secret.length === 0) {
    return undefined
  }
  return { publicOrigin, secret }
}

function blankRecord(date: string, runId: string, now: Date): DigestRunRecord {
  const stamp = now.toISOString()
  return {
    v: 1,
    runId,
    date,
    status: 'running',
    phase: 'plan',
    startedAt: stamp,
    updatedAt: stamp,
    planOffset: 0,
    pendingEval: [],
    evalIndex: 0,
    jevCalls: 0,
    selectedIds: [],
    summarizeIndex: 0,
    prepared: [],
    skipped: 0,
    exhaustedSkips: 0,
    articleId: null,
    qrCount: 0,
  }
}

function withUpdate(record: DigestRunRecord, now: Date, patch: Partial<DigestRunRecord>): DigestRunRecord {
  return { ...record, ...patch, updatedAt: now.toISOString() }
}

async function touch(ctx: DeliveryContext, loaded: DigestRunLoaded): Promise<DigestRunLoaded | null> {
  return save(ctx.runStore, withUpdate(loaded.record, ctx.now(), {}), loaded.etag)
}

function stale(record: DigestRunRecord, now: Date): boolean {
  const updated = Date.parse(record.updatedAt)
  if (Number.isNaN(updated)) {
    return true
  }
  return now.getTime() - updated >= DIGEST_STEP_STALE_MS
}

async function removeCurrentIssue(ctx: DeliveryContext): Promise<boolean> {
  try {
    await unpublishDailyDigests(ctx.store)
    return true
  } catch {
    return false
  }
}

async function finishEmpty(ctx: DeliveryContext, loaded: DigestRunLoaded): Promise<DigestDeliveryOutcome> {
  const next = withUpdate(loaded.record, ctx.now(), { status: 'empty', articleId: null, qrCount: 0 })
  const saved = await save(ctx.runStore, next, loaded.etag)
  if (saved === null) {
    return retry()
  }
  logTerminal(saved.record, ctx.now(), ctx.attempts, undefined, undefined)
  const result = toResult(saved.record)
  if (!(await removeCurrentIssue(ctx)) && !isFinalDigestAttempt(ctx.attempts)) {
    return retry(result)
  }
  return ack(result, result)
}

async function finishPublished(
  ctx: DeliveryContext,
  loaded: DigestRunLoaded,
  articleId: DigestRunRecord['articleId'],
  qrCount: number,
): Promise<DigestDeliveryOutcome> {
  const next = withUpdate(loaded.record, ctx.now(), { status: 'published', articleId, qrCount })
  const saved = await save(ctx.runStore, next, loaded.etag)
  if (saved === null) {
    return retry()
  }
  logTerminal(saved.record, ctx.now(), ctx.attempts, undefined, undefined)
  const result = toResult(saved.record)
  return ack(result, result)
}

async function failDay(
  ctx: DeliveryContext,
  loaded: DigestRunLoaded,
  stage: DailyDigestStage,
  errorKind: DailyDigestErrorKind,
): Promise<DigestDeliveryOutcome> {
  const next = withUpdate(loaded.record, ctx.now(), { status: 'failed', articleId: null, qrCount: 0 })
  const saved = await save(ctx.runStore, next, loaded.etag)
  if (saved === null) {
    const current = await ctx.runStore.get(loaded.record.date).catch(() => null)
    if (current !== null && current.record.runId === loaded.record.runId && current.record.status !== 'running') {
      return ack(toResult(current.record))
    }
    if (!isFinalDigestAttempt(ctx.attempts)) {
      return retry()
    }
    logTerminal(next, ctx.now(), ctx.attempts, stage, errorKind)
    const unsaved = toResult(next)
    return ack(unsaved, unsaved)
  }
  logTerminal(saved.record, ctx.now(), ctx.attempts, stage, errorKind)
  const result = toResult(saved.record)
  if (!(await removeCurrentIssue(ctx)) && !isFinalDigestAttempt(ctx.attempts)) {
    return retry(result)
  }
  return ack(result, result)
}

function continueWith(record: DigestRunRecord, extra: readonly DigestEnqueue[] = []): DigestDeliveryOutcome {
  return { action: 'ack', enqueue: [messageFor(record), ...extra], finished: null, decided: null }
}

async function stepStart(ctx: DeliveryContext, date: string): Promise<DigestDeliveryOutcome> {
  const existing = await ctx.runStore.get(date)
  const record = blankRecord(date, newDigestRunId(), ctx.now())
  const wrote = await ctx.runStore.put(record, existing?.etag ?? null)
  if (!wrote.ok) {
    if (!isFinalDigestAttempt(ctx.attempts)) {
      return retry()
    }
    logDailyDigest({
      date,
      status: 'failed',
      stage: 'start',
      selected: 0,
      summarized: 0,
      skipped: 0,
      durationMs: 0,
      qrCount: 0,
      errorKind: 'internal_error',
      attempt: ctx.attempts,
    })
    const failed = {
      date,
      status: 'failed' as const,
      selected: 0,
      summarized: 0,
      skipped: 0,
      articleId: null,
      qrCount: 0,
    }
    return ack(failed, failed)
  }
  const started: DigestRunLoaded = { record, etag: wrote.etag }
  logRunning(record, 'start', ctx.now(), ctx.attempts)
  const enqueue: DigestEnqueue[] = [messageFor(record)]
  if (ctx.scheduleWatchdog) {
    enqueue.push(watchdogMessage(record))
  }
  return { action: 'ack', enqueue, finished: null, decided: null }
}

async function alignOrRepair(
  ctx: DeliveryContext,
  loaded: DigestRunLoaded,
  step: DigestRunPhase | 'watchdog',
  cursor: number | undefined,
): Promise<DigestDeliveryOutcome | null> {
  const { record } = loaded
  if (record.status !== 'running') {
    const removeIssue = record.status === 'failed' || record.status === 'empty'
    if (removeIssue && !(await removeCurrentIssue(ctx)) && !isFinalDigestAttempt(ctx.attempts)) {
      return retry()
    }
    return ack(toResult(record))
  }
  if (step === 'watchdog') {
    return null
  }
  const matches =
    record.phase === step &&
    (step === 'publish' ||
      (step === 'plan' && record.planOffset === cursor) ||
      (step === 'evaluate' && record.evalIndex === cursor) ||
      (step === 'summarize' && record.summarizeIndex === cursor))
  if (matches) {
    return null
  }
  return continueWith(record)
}

async function stepPlan(ctx: DeliveryContext, loaded: DigestRunLoaded): Promise<DigestDeliveryOutcome> {
  logRunning(loaded.record, 'plan', ctx.now(), ctx.attempts)
  const touched = await touch(ctx, loaded)
  if (touched === null) {
    return retry()
  }
  const page = await listPage(ctx.candidateStore, touched.record.planOffset)
  const used = await ctx.digestStore.listPublishedCanonicalUrlsExcept(touched.record.date)
  const pending = [...touched.record.pendingEval]
  const seen = new Set(pending.map((item) => item.id))
  for (const candidate of page.items) {
    if (seen.has(candidate.id) || used.has(candidate.canonicalUrl) || !digestNeedsEvaluation(candidate)) {
      continue
    }
    seen.add(candidate.id)
    pending.push({
      id: candidate.id,
      canonicalUrl: candidate.canonicalUrl,
      discoveredAt: candidate.discoveredAt,
    })
  }
  const nextOffset = touched.record.planOffset + page.items.length
  const planDone = page.items.length === 0 || nextOffset >= page.total
  const next = withUpdate(touched.record, ctx.now(), {
    pendingEval: planDone ? orderDigestEvaluations(pending) : pending,
    planOffset: planDone ? touched.record.planOffset : nextOffset,
    phase: planDone ? 'evaluate' : 'plan',
    evalIndex: 0,
  })
  const saved = await save(ctx.runStore, next, touched.etag)
  if (saved === null) {
    return retry()
  }
  return continueWith(saved.record)
}

async function poolFor(ctx: DeliveryContext, date: string): Promise<{
  readonly byId: Map<CandidateId, CandidateArticle>
  readonly used: ReadonlySet<string>
}> {
  const used = await ctx.digestStore.listPublishedCanonicalUrlsExcept(date)
  const byId = new Map<CandidateId, CandidateArticle>()
  for (const candidate of await listAllListed(ctx.candidateStore)) {
    if (!used.has(candidate.canonicalUrl)) {
      byId.set(candidate.id, candidate)
    }
  }
  return { byId, used }
}

async function beginSummarize(
  ctx: DeliveryContext,
  loaded: DigestRunLoaded,
  byId: ReadonlyMap<CandidateId, CandidateArticle>,
  used: ReadonlySet<string>,
): Promise<DigestDeliveryOutcome> {
  const sourceInterest = digestSourceInterestPrior(
    joinDigestInterest(await ctx.digestStore.listInterestSnapshot()),
    ctx.now().getTime(),
  )
  const selected = selectDigestCandidates([...byId.values()], {
    usedCanonicalUrls: used,
    sourceInterest,
  })
  if (selected.length === 0) {
    if (loaded.record.exhaustedSkips > 0) {
      return failDay(ctx, loaded, 'evaluate', 'retry_exhausted')
    }
    return finishEmpty(ctx, loaded)
  }
  const next = withUpdate(loaded.record, ctx.now(), {
    phase: 'summarize',
    selectedIds: selected.map((candidate) => candidate.id),
    summarizeIndex: 0,
  })
  const saved = await save(ctx.runStore, next, loaded.etag)
  if (saved === null) {
    return retry()
  }
  logRunning(saved.record, 'evaluate', ctx.now(), ctx.attempts)
  return continueWith(saved.record)
}

async function stepEvaluate(ctx: DeliveryContext, loaded: DigestRunLoaded): Promise<DigestDeliveryOutcome> {
  logRunning(loaded.record, 'evaluate', ctx.now(), ctx.attempts)
  const touched = await touch(ctx, loaded)
  if (touched === null) {
    return retry()
  }
  const { byId, used } = await poolFor(ctx, touched.record.date)
  const maxJevCalls = ctx.deps.maxJevCalls ?? DIGEST_MAX_JEV_CALLS
  let index = touched.record.evalIndex
  let jevCalls = touched.record.jevCalls
  let exhaustedSkips = touched.record.exhaustedSkips
  let skippedHeavy = false
  const pending = touched.record.pendingEval

  while (
    index < pending.length &&
    jevCalls < maxJevCalls &&
    !digestSelectionSaturated([...byId.values()], used)
  ) {
    const ref: DigestEvalRef | undefined = pending[index]
    const candidate = ref === undefined ? undefined : byId.get(ref.id)
    if (
      candidate === undefined ||
      !digestNeedsEvaluation(candidate) ||
      digestSourceAtCap(byId.values(), digestSourceKey(candidate), used)
    ) {
      index += 1
      continue
    }
    if (isFinalDigestAttempt(ctx.attempts)) {
      index += 1
      exhaustedSkips += 1
      skippedHeavy = true
      break
    }
    try {
      const result = await reevaluateCandidate({
        candidateId: candidate.id,
        force: false,
        store: ctx.candidateStore,
        fetchPage: ctx.fetchPage,
        now: ctx.now,
        jevDeps: { OPENROUTER_API_KEY: ctx.env.OPENROUTER_API_KEY },
        ...(ctx.deps.evaluateRecommend === undefined ? {} : { evaluate: ctx.deps.evaluateRecommend }),
      })
      if (result.ok) {
        byId.set(result.value.candidate.id, result.value.candidate)
      }
    } catch {
      // A failed judgment does not fail the issue. The next delivery continues the list.
    }
    jevCalls += 1
    index += 1
    break
  }

  const progressed = withUpdate(touched.record, ctx.now(), { evalIndex: index, jevCalls, exhaustedSkips })
  const saved = await save(ctx.runStore, progressed, touched.etag)
  if (saved === null) {
    return retry()
  }
  if (skippedHeavy) {
    logDailyDigest({
      date: saved.record.date,
      status: 'running',
      stage: 'evaluate',
      selected: saved.record.selectedIds.length,
      summarized: saved.record.prepared.length,
      skipped: saved.record.skipped,
      durationMs: elapsedMs(saved.record, ctx.now()),
      qrCount: saved.record.qrCount,
      errorKind: 'retry_exhausted',
      attempt: ctx.attempts,
    })
  }
  const done =
    saved.record.evalIndex >= saved.record.pendingEval.length ||
    saved.record.jevCalls >= maxJevCalls ||
    digestSelectionSaturated([...byId.values()], used)
  if (!done) {
    return continueWith(saved.record)
  }
  return beginSummarize(ctx, saved, byId, used)
}

async function stepSummarize(ctx: DeliveryContext, loaded: DigestRunLoaded): Promise<DigestDeliveryOutcome> {
  const current = loaded.record
  if (current.summarizeIndex >= current.selectedIds.length) {
    if (current.prepared.length === 0) {
      return current.exhaustedSkips > 0 ? failDay(ctx, loaded, 'summarize', 'retry_exhausted') : finishEmpty(ctx, loaded)
    }
    const publishing = withUpdate(current, ctx.now(), { phase: 'publish' })
    const saved = await save(ctx.runStore, publishing, loaded.etag)
    if (saved === null) {
      return retry()
    }
    return continueWith(saved.record)
  }

  logRunning(current, 'summarize', ctx.now(), ctx.attempts)
  const touched = await touch(ctx, loaded)
  if (touched === null) {
    return retry()
  }
  const candidateId = touched.record.selectedIds[touched.record.summarizeIndex]
  if (candidateId === undefined) {
    return failDay(ctx, touched, 'summarize', 'internal_error')
  }

  let prepared = touched.record.prepared
  let skipped = touched.record.skipped
  let exhaustedSkips = touched.record.exhaustedSkips
  if (isFinalDigestAttempt(ctx.attempts)) {
    skipped += 1
    exhaustedSkips += 1
  } else {
    const candidate = await ctx.candidateStore.getById(candidateId)
    const summarize = ctx.deps.summarize ?? summarizeDigestArticle
    if (candidate === null) {
      skipped += 1
    } else {
      try {
        const summarized = await summarize(candidate, {
          OPENAI_API_KEY: ctx.env.OPENAI_API_KEY,
          fetchPage: ctx.fetchPage,
          maxChars: digestSummaryCharBudget(touched.record.selectedIds.length),
        })
        if (summarized.ok) {
          prepared = [...prepared, summarized.value]
        } else {
          skipped += 1
        }
      } catch {
        skipped += 1
      }
    }
  }

  const index = touched.record.summarizeIndex + 1
  const finishedSummaries = index >= touched.record.selectedIds.length
  let phase: DigestRunPhase = 'summarize'
  if (finishedSummaries && prepared.length > 0) {
    phase = 'publish'
  }
  const next = withUpdate(touched.record, ctx.now(), {
    prepared,
    skipped,
    exhaustedSkips,
    summarizeIndex: index,
    phase,
  })
  const saved = await save(ctx.runStore, next, touched.etag)
  if (saved === null) {
    return retry()
  }
  if (isFinalDigestAttempt(ctx.attempts)) {
    logDailyDigest({
      date: saved.record.date,
      status: 'running',
      stage: 'summarize',
      selected: saved.record.selectedIds.length,
      summarized: saved.record.prepared.length,
      skipped: saved.record.skipped,
      durationMs: elapsedMs(saved.record, ctx.now()),
      qrCount: saved.record.qrCount,
      errorKind: 'retry_exhausted',
      attempt: ctx.attempts,
    })
  }
  if (!finishedSummaries) {
    return continueWith(saved.record)
  }
  if (prepared.length === 0) {
    return saved.record.exhaustedSkips > 0
      ? failDay(ctx, saved, 'summarize', 'retry_exhausted')
      : finishEmpty(ctx, saved)
  }
  return continueWith(saved.record)
}

async function stepPublish(ctx: DeliveryContext, loaded: DigestRunLoaded): Promise<DigestDeliveryOutcome> {
  if (isFinalDigestAttempt(ctx.attempts)) {
    return failDay(ctx, loaded, 'publish', 'retry_exhausted')
  }
  logRunning(loaded.record, 'publish', ctx.now(), ctx.attempts)
  const touched = await touch(ctx, loaded)
  if (touched === null) {
    return retry()
  }
  if (touched.record.prepared.length === 0) {
    return touched.record.exhaustedSkips > 0
      ? failDay(ctx, touched, 'publish', 'retry_exhausted')
      : finishEmpty(ctx, touched)
  }
  const qr = digestQrInput(ctx.env)
  const built = await buildDailyDigestWrite({
    date: touched.record.date,
    items: touched.record.prepared,
    ...(qr === undefined ? {} : { qr }),
  })
  const published = await publishLatestDaily(ctx.store, built.write)
  await ctx.digestStore.replacePublishedItems(
    touched.record.date,
    publishedHistory(touched.record.date, touched.record.prepared),
  )
  return finishPublished(ctx, touched, published.meta.id, qr === undefined ? 0 : touched.record.prepared.length)
}

async function stepWatchdog(ctx: DeliveryContext, loaded: DigestRunLoaded): Promise<DigestDeliveryOutcome> {
  const { record } = loaded
  if (record.status !== 'running') {
    return ack(toResult(record))
  }
  if (!stale(record, ctx.now())) {
    return { action: 'ack', enqueue: [watchdogMessage(record)], finished: null, decided: null }
  }
  return failDay(ctx, loaded, 'watchdog', 'retry_exhausted')
}

async function dispatch(ctx: DeliveryContext, message: NormalizedMessage): Promise<DigestDeliveryOutcome> {
  if (message.step === 'start') {
    return stepStart(ctx, message.date)
  }
  const loaded = await ctx.runStore.get(message.date)
  if (loaded === null || loaded.record.runId !== message.runId) {
    return ack()
  }
  const cursor = 'cursor' in message ? message.cursor : undefined
  const repaired = await alignOrRepair(ctx, loaded, message.step === 'watchdog' ? 'watchdog' : message.step, cursor)
  if (repaired !== null) {
    return repaired
  }
  if (message.step === 'plan') {
    return stepPlan(ctx, loaded)
  }
  if (message.step === 'evaluate') {
    return stepEvaluate(ctx, loaded)
  }
  if (message.step === 'summarize') {
    return stepSummarize(ctx, loaded)
  }
  if (message.step === 'publish') {
    return stepPublish(ctx, loaded)
  }
  return stepWatchdog(ctx, loaded)
}

export async function processDigestDelivery(
  env: Cloudflare.Env,
  deps: RunDailyDigestDeps,
  body: DigestQueueMessage,
  attempts: number,
  options: { readonly scheduleWatchdog?: boolean } = {},
): Promise<DigestDeliveryOutcome> {
  const message = parseDigestQueueMessage(body)
  if (message === null) {
    return ack()
  }
  const ctx: DeliveryContext = {
    env,
    deps,
    runStore: runStoreFor(env, deps),
    attempts,
    scheduleWatchdog: options.scheduleWatchdog ?? true,
    now: deps.now ?? (() => new Date()),
    fetchPage: deps.fetchPage,
    store: storeFor(env, deps),
    candidateStore: candidateStoreFor(env, deps),
    digestStore: digestStoreFor(env, deps),
  }
  try {
    return await dispatch(ctx, message)
  } catch {
    if (!isFinalDigestAttempt(attempts)) {
      return retry()
    }
    const loaded = await ctx.runStore.get(message.date).catch(() => null)
    if (loaded === null || (message.step !== 'start' && loaded.record.runId !== message.runId)) {
      logDailyDigest({
        date: message.date,
        status: 'failed',
        selected: 0,
        summarized: 0,
        skipped: 0,
        durationMs: 0,
        qrCount: 0,
        errorKind: 'internal_error',
        attempt: attempts,
        ...(message.step === 'start' ? {} : { stage: message.step }),
      })
      const failed = {
        date: message.date,
        status: 'failed' as const,
        selected: 0,
        summarized: 0,
        skipped: 0,
        articleId: null,
        qrCount: 0,
      }
      return ack(failed, failed)
    }
    return failDay(ctx, loaded, message.step === 'start' ? 'start' : message.step, 'internal_error')
  }
}
