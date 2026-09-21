import { collectFeed } from '../feeds/collect'
import { errorMessage } from '../http/error-response'
import { logFeed } from '../log'
import { createD1CandidateStore } from '../store/d1-candidates'
import { createD1FeedSourceStore } from '../store/d1-sources'
import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import { fetchFeed as defaultFetchFeed } from '../feeds/fetch'
import type {
  CandidateStore,
  FeedCollectionResult,
  FeedQueueMessage,
  FeedRunId,
  FeedSource,
  FeedSourceStore,
  FetchFeed,
  FetchPage,
} from '../types'
import { isFeedRunId, isFeedSourceId } from '../types'

export const FEED_QUEUE_NAME = 'xteink-read-later-feed'
export const FEED_QUEUE_MAX_RETRIES = 3

export type FeedQueueHandlerDeps = {
  readonly sourceStore?: FeedSourceStore
  readonly candidateStore?: CandidateStore
  readonly createSourceStore?: (env: Cloudflare.Env) => FeedSourceStore
  readonly createCandidateStore?: (env: Cloudflare.Env) => CandidateStore
  readonly fetchFeed?: FetchFeed
  readonly fetchPage?: FetchPage
  readonly now?: () => Date
}

function nowIso(now: () => Date): string {
  return now().toISOString()
}

function stores(env: Cloudflare.Env, deps: FeedQueueHandlerDeps): {
  readonly sources: FeedSourceStore
  readonly candidates: CandidateStore
} {
  return {
    sources:
      deps.sourceStore ?? (deps.createSourceStore ?? createD1FeedSourceStore)(env),
    candidates:
      deps.candidateStore ?? (deps.createCandidateStore ?? createD1CandidateStore)(env),
  }
}

export function parseFeedQueueMessage(body: unknown): FeedQueueMessage | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  if (!('sourceId' in body) || !('runId' in body)) {
    return null
  }
  if (typeof body.sourceId !== 'string' || !isFeedSourceId(body.sourceId)) {
    return null
  }
  if (typeof body.runId !== 'string' || !isFeedRunId(body.runId)) {
    return null
  }
  return { sourceId: body.sourceId, runId: body.runId }
}

export function shouldRetryFeedAttempt(attempts: number): boolean {
  return attempts <= FEED_QUEUE_MAX_RETRIES
}

export function shouldRetryFeedError(kind: string, attempts: number): boolean {
  if (!shouldRetryFeedAttempt(attempts)) {
    return false
  }
  return kind === 'fetch_failed'
}

function shouldProcessFeedRun(source: FeedSource, runId: FeedRunId): boolean {
  if (source.collectionRunId !== runId) {
    return false
  }
  if (source.collectionStatus === 'ready') {
    return false
  }
  if (source.collectionStatus === 'failed') {
    return source.collectionErrorCode === 'queue_failed'
  }
  return true
}

async function applyResult(
  sources: FeedSourceStore,
  source: FeedSource,
  result: FeedCollectionResult,
  attempt: number,
  now: () => Date,
): Promise<void> {
  const updatedAt = nowIso(now)
  await sources.put({
    ...source,
    collectionRunId: result.runId,
    collectionStatus: result.status,
    collectionAttempt: attempt,
    collectionErrorCode: result.error?.kind ?? null,
    collectionErrorMessage: result.error === null ? null : errorMessage(result.error),
    itemsSeen: result.itemsSeen,
    itemsRegistered: result.itemsRegistered,
    itemsDuplicate: result.itemsDuplicate,
    itemsSkipped: result.itemsSkipped,
    lastCollectedAt: updatedAt,
    updatedAt,
  })
}

async function processMessage(
  message: Message<FeedQueueMessage>,
  env: Cloudflare.Env,
  deps: FeedQueueHandlerDeps,
): Promise<void> {
  const parsed = parseFeedQueueMessage(message.body)
  if (parsed === null) {
    logFeed({ stage: 'collect', durationMs: 0, errorKind: 'invalid_url' })
    message.ack()
    return
  }

  const now = deps.now ?? (() => new Date())
  const { sources, candidates } = stores(env, deps)
  const source = await sources.getById(parsed.sourceId)
  if (source === null || !shouldProcessFeedRun(source, parsed.runId)) {
    message.ack()
    return
  }

  const started = Date.now()
  await sources.put({
    ...source,
    collectionStatus: 'running',
    collectionAttempt: message.attempts,
    updatedAt: nowIso(now),
  })

  try {
    const result = await collectFeed(source, parsed.runId, {
      candidateStore: candidates,
      fetchFeed: deps.fetchFeed ?? defaultFetchFeed,
      fetchPage: deps.fetchPage ?? defaultFetchPage,
      now,
    })
    const latest = (await sources.getById(source.id)) ?? source
    if (latest.collectionRunId !== parsed.runId) {
      message.ack()
      return
    }
    if (result.status === 'failed' && result.error !== null && shouldRetryFeedError(result.error.kind, message.attempts)) {
      logFeed(
        {
          stage: 'collect',
          durationMs: Date.now() - started,
          errorKind: result.error.kind,
          sourceId: source.id,
          runId: parsed.runId,
          attempt: message.attempts,
        },
      )
      message.retry()
      return
    }
    await applyResult(sources, latest, result, message.attempts, now)
    logFeed({
      stage: 'collect',
      durationMs: Date.now() - started,
      sourceId: source.id,
      runId: parsed.runId,
      attempt: message.attempts,
      ...(result.error === null ? {} : { errorKind: result.error.kind }),
    })
    message.ack()
  } catch {
    logFeed({
      stage: 'collect',
      durationMs: Date.now() - started,
      errorKind: 'internal_error',
      sourceId: source.id,
      runId: parsed.runId,
      attempt: message.attempts,
    })
    if (shouldRetryFeedAttempt(message.attempts)) {
      message.retry()
      return
    }
    const latest = (await sources.getById(source.id)) ?? source
    await sources.put({
      ...latest,
      collectionStatus: 'failed',
      collectionAttempt: message.attempts,
      collectionErrorCode: 'internal_error',
      collectionErrorMessage: 'Feed collection failed after an unexpected error',
      lastCollectedAt: nowIso(now),
      updatedAt: nowIso(now),
    })
    message.ack()
  }
}

export function createFeedQueueHandler(
  deps: FeedQueueHandlerDeps = {},
): (batch: MessageBatch<FeedQueueMessage>, env: Cloudflare.Env) => Promise<void> {
  return async (batch, env) => {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env, deps)
      } catch {
        message.ack()
      }
    }
  }
}
