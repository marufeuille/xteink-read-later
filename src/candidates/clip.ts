import { logCandidateClip } from '../log'
import { enqueueClipJob } from '../job/enqueue'
import { isActiveClipJob } from '../job/clip'
import { loadCandidateDelivery } from './delivery'
import {
  articleIdFromCanonicalUrl,
  clipJobIdFromUrl,
  err,
  ok,
  type ArticleId,
  type ArticleStore,
  type CandidateArticle,
  type CandidateClipBody,
  type CandidateStore,
  type CandidateUnsendableError,
  type CandidateUnsendableReason,
  type ClipJobRecord,
  type ClipQueueMessage,
  type NotFoundError,
  type QueueFailedError,
  type Result,
} from '../types'

export type SendCandidateClipInput = {
  readonly candidateId: CandidateArticle['id']
  readonly regenerate: boolean
  readonly candidateStore: CandidateStore
  readonly articleStore: ArticleStore
  readonly queue: Queue<ClipQueueMessage>
  readonly now: () => Date
}

export type SendCandidateClipValue = {
  readonly candidate: CandidateArticle
  readonly job: ClipJobRecord | null
  readonly reused: boolean
  readonly regenerated: boolean
  readonly body: CandidateClipBody
}

function iso(now: () => Date): string {
  return now().toISOString()
}

export function candidateClipBlockReason(candidate: CandidateArticle): CandidateUnsendableReason | null {
  if (candidate.listingState === 'excluded' || candidate.exclusionReason === 'paywalled') {
    return candidate.exclusionReason === 'paywalled' ? 'paywalled' : 'excluded'
  }
  if (candidate.fullTextState === 'unavailable') {
    return 'unavailable'
  }
  if (candidate.fetchStatus === 'fetch_failed') {
    return 'fetch_failed'
  }
  return null
}

async function recordClipLink(
  store: CandidateStore,
  candidate: CandidateArticle,
  patch: {
    readonly clipJobId: CandidateArticle['clipJobId']
    readonly clipRunId: CandidateArticle['clipRunId']
    readonly completedArticleId?: ArticleId | null
    readonly selectedAt: string
    readonly updatedAt: string
  },
): Promise<CandidateArticle> {
  const updated: CandidateArticle = {
    ...candidate,
    clipJobId: patch.clipJobId,
    clipRunId: patch.clipRunId,
    selectedAt: candidate.selectedAt ?? patch.selectedAt,
    completedArticleId:
      patch.completedArticleId === undefined ? candidate.completedArticleId : patch.completedArticleId,
    updatedAt: patch.updatedAt,
  }
  try {
    await store.put(updated)
  } catch {
    return updated
  }
  return updated
}

function toBody(input: {
  readonly candidateId: CandidateArticle['id']
  readonly jobId: CandidateClipBody['jobId']
  readonly job: ClipJobRecord | null
  readonly articleId: ArticleId | null
  readonly reused: boolean
  readonly regenerated: boolean
  readonly deliveryState: CandidateClipBody['deliveryState']
}): CandidateClipBody {
  const status =
    input.job?.status === 'ready' || input.deliveryState === 'available'
      ? 'ready'
      : input.job?.status === 'failed'
        ? 'failed'
        : 'queued'
  return {
    candidateId: input.candidateId,
    jobId: input.job?.jobId ?? input.jobId,
    runId: input.job?.runId ?? null,
    status,
    reused: input.reused,
    regenerated: input.regenerated,
    deliveryState: input.deliveryState,
    articleId: input.articleId,
  }
}

export async function sendCandidateClip(
  input: SendCandidateClipInput,
): Promise<Result<SendCandidateClipValue, NotFoundError | CandidateUnsendableError | QueueFailedError>> {
  const candidate = await input.candidateStore.getById(input.candidateId)
  if (candidate === null) {
    return err({ kind: 'not_found' })
  }
  const blocked = candidateClipBlockReason(candidate)
  if (blocked !== null) {
    return err({ kind: 'candidate_unsendable', reason: blocked })
  }

  const nowMs = input.now().getTime()
  const selectedAt = iso(input.now)
  const jobId = candidate.clipJobId ?? (await clipJobIdFromUrl(candidate.canonicalUrl))
  const existingJob = await input.articleStore.getJob(jobId)
  const canonicalArticleId = await articleIdFromCanonicalUrl(candidate.canonicalUrl)

  if (!input.regenerate) {
    if (isActiveClipJob(existingJob, nowMs)) {
      const saved = await recordClipLink(input.candidateStore, candidate, {
        clipJobId: existingJob.jobId,
        clipRunId: existingJob.runId,
        selectedAt,
        updatedAt: selectedAt,
      })
      logCandidateClip({
        action: 'select',
        candidateId: saved.id,
        jobId: existingJob.jobId,
        runId: existingJob.runId,
        selectedAt: saved.selectedAt ?? selectedAt,
        discoveredAt: saved.discoveredAt,
        publishedAt: saved.publishedAt,
        reused: true,
        regenerated: false,
      })
      return ok({
        candidate: saved,
        job: existingJob,
        reused: true,
        regenerated: false,
        body: toBody({
          candidateId: saved.id,
          jobId: existingJob.jobId,
          job: existingJob,
          articleId: null,
          reused: true,
          regenerated: false,
          deliveryState: 'preparing',
        }),
      })
    }

    const readyId = existingJob?.status === 'ready' ? existingJob.articleId : canonicalArticleId
    const epub = await input.articleStore.getEpub(readyId)
    const meta = epub === null ? null : await input.articleStore.getMeta(readyId)
    if (epub !== null && meta !== null) {
      const saved = await recordClipLink(input.candidateStore, candidate, {
        clipJobId: existingJob?.jobId ?? jobId,
        clipRunId: existingJob?.runId ?? candidate.clipRunId,
        completedArticleId: readyId,
        selectedAt,
        updatedAt: selectedAt,
      })
      logCandidateClip({
        action: 'reuse',
        candidateId: saved.id,
        jobId: saved.clipJobId ?? jobId,
        ...(saved.clipRunId === null ? {} : { runId: saved.clipRunId }),
        articleId: readyId,
        selectedAt: saved.selectedAt ?? selectedAt,
        discoveredAt: saved.discoveredAt,
        publishedAt: saved.publishedAt,
        reused: true,
        regenerated: false,
      })
      return ok({
        candidate: saved,
        job: existingJob,
        reused: true,
        regenerated: false,
        body: toBody({
          candidateId: saved.id,
          jobId,
          job: existingJob,
          articleId: readyId,
          reused: true,
          regenerated: false,
          deliveryState: 'available',
        }),
      })
    }
  }

  const queued = await enqueueClipJob({
    store: input.articleStore,
    queue: input.queue,
    url: candidate.canonicalUrl,
    nowMs,
    reuseReady: false,
  })
  const job = queued.job
  const saved = await recordClipLink(input.candidateStore, candidate, {
    clipJobId: job.jobId,
    clipRunId: job.runId,
    selectedAt,
    updatedAt: selectedAt,
    ...(input.regenerate ? { completedArticleId: null } : {}),
  })
  logCandidateClip({
    action: input.regenerate ? 'regenerate' : 'select',
    candidateId: saved.id,
    jobId: job.jobId,
    runId: job.runId,
    selectedAt: saved.selectedAt ?? selectedAt,
    discoveredAt: saved.discoveredAt,
    publishedAt: saved.publishedAt,
    reused: false,
    regenerated: input.regenerate,
  })
  if (!queued.ok) {
    return err(queued.error)
  }
  const delivery = await loadCandidateDelivery(saved, input.articleStore, Date.now())
  return ok({
    candidate: saved,
    job,
    reused: false,
    regenerated: input.regenerate,
    body: {
      candidateId: saved.id,
      jobId: job.jobId,
      runId: job.runId,
      status: job.status === 'ready' ? 'ready' : job.status === 'failed' ? 'failed' : 'queued',
      reused: false,
      regenerated: input.regenerate,
      deliveryState: delivery.deliveryState,
      articleId: delivery.articleId,
    },
  })
}
