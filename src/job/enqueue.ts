import { errorMessage } from '../http/error-response'
import { isActiveClipJob } from './clip'
import { logPipeline } from '../log'
import type {
  ArticleStore,
  ClipFailedJob,
  ClipJobRecord,
  ClipQueueMessage,
  ClipQueuedJob,
  HttpUrl,
  QueueFailedError,
} from '../types'
import { clipJobIdFromUrl, newClipRunId } from '../types'

export type EnqueueClipOutcome =
  | { readonly ok: true; readonly kind: 'queued' | 'active' | 'reused'; readonly job: ClipJobRecord }
  | { readonly ok: false; readonly kind: 'queue_failed'; readonly job: ClipFailedJob; readonly error: QueueFailedError }

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString()
}

export async function enqueueClipJob(input: {
  readonly store: ArticleStore
  readonly queue: Queue<ClipQueueMessage>
  readonly url: HttpUrl
  readonly nowMs: number
  readonly reuseReady: boolean
}): Promise<EnqueueClipOutcome> {
  const jobId = await clipJobIdFromUrl(input.url)
  const existing = await input.store.getJob(jobId)
  if (isActiveClipJob(existing, input.nowMs)) {
    return { ok: true, kind: 'active', job: existing }
  }
  if (input.reuseReady && existing?.status === 'ready') {
    const epub = await input.store.getEpub(existing.articleId)
    if (epub !== null) {
      return { ok: true, kind: 'reused', job: existing }
    }
  }

  const queued: ClipQueuedJob = {
    jobId,
    runId: newClipRunId(),
    sourceUrl: input.url,
    status: 'queued',
    articleId: null,
    error: null,
    attempt: 0,
    createdAt: existing?.createdAt ?? nowIso(input.nowMs),
    updatedAt: nowIso(input.nowMs),
  }
  await input.store.putJob(queued)
  const started = Date.now()
  const queueLog = { jobId, runId: queued.runId, attempt: 0 }
  try {
    await input.queue.send({ jobId, runId: queued.runId, url: input.url })
  } catch (cause) {
    const error: QueueFailedError = {
      kind: 'queue_failed',
      reason: cause instanceof Error ? cause.message : 'queue send failed',
    }
    const failed: ClipFailedJob = {
      ...queued,
      status: 'failed',
      error: { code: error.kind, message: errorMessage(error) },
      updatedAt: nowIso(Date.now()),
    }
    await input.store.putJob(failed)
    logPipeline({ stage: 'queue', durationMs: Date.now() - started, errorKind: error.kind }, queueLog)
    return { ok: false, kind: 'queue_failed', job: failed, error }
  }
  logPipeline({ stage: 'queue', durationMs: Date.now() - started }, queueLog)
  return { ok: true, kind: 'queued', job: queued }
}
