import {
  newFeedRunId,
  err,
  ok,
  type FeedCollectBody,
  type FeedQueueMessage,
  type FeedSource,
  type FeedSourceId,
  type FeedSourceStore,
  type QueueFailedError,
  type Result,
  type SourceDisabledError,
} from '../types'
import { isActiveFeedCollection } from './source-input'

export type EnqueueCollectionDeps = {
  readonly store: FeedSourceStore
  readonly queue: Queue<FeedQueueMessage>
  readonly now: () => Date
}

export type EnqueueEnabledFailure = {
  readonly sourceId: FeedSourceId
  readonly error: SourceDisabledError | QueueFailedError
}

export type EnqueueEnabledResult = {
  readonly runs: readonly FeedCollectBody[]
  readonly failures: readonly EnqueueEnabledFailure[]
}

export async function enqueueCollection(
  source: FeedSource,
  deps: EnqueueCollectionDeps,
): Promise<Result<FeedCollectBody, SourceDisabledError | QueueFailedError>> {
  const at = deps.now()
  if (!source.enabled) {
    return err({ kind: 'source_disabled' })
  }
  if (isActiveFeedCollection(source, at.getTime()) && source.collectionRunId !== null) {
    return ok({ sourceId: source.id, runId: source.collectionRunId, status: 'queued' })
  }
  const runId = newFeedRunId()
  const updated: FeedSource = {
    ...source,
    collectionRunId: runId,
    collectionStatus: 'queued',
    collectionAttempt: 0,
    collectionErrorCode: null,
    collectionErrorMessage: null,
    updatedAt: at.toISOString(),
  }
  await deps.store.put(updated)
  try {
    await deps.queue.send({ sourceId: source.id, runId })
  } catch (cause) {
    const error: QueueFailedError = {
      kind: 'queue_failed',
      reason: cause instanceof Error ? cause.message : 'queue send failed',
    }
    await deps.store.put({
      ...updated,
      collectionStatus: 'failed',
      collectionErrorCode: error.kind,
      collectionErrorMessage: error.reason,
      updatedAt: deps.now().toISOString(),
    })
    return err(error)
  }
  return ok({ sourceId: source.id, runId, status: 'queued' })
}

export async function enqueueEnabledCollections(
  deps: EnqueueCollectionDeps,
): Promise<EnqueueEnabledResult> {
  const runs: FeedCollectBody[] = []
  const failures: EnqueueEnabledFailure[] = []
  for (const source of await deps.store.listEnabled()) {
    const queued = await enqueueCollection(source, deps)
    if (queued.ok) {
      runs.push(queued.value)
      continue
    }
    failures.push({ sourceId: source.id, error: queued.error })
  }
  return { runs, failures }
}
