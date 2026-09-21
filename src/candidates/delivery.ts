import { isActiveClipJob } from '../job/clip'
import type {
  ArticleId,
  ArticleStore,
  CandidateArticle,
  CandidateDeliveryState,
  CandidateId,
  CandidatePublic,
  CandidateStore,
  ClipJobError,
  ClipJobId,
  ClipJobRecord,
  ClipRunId,
} from '../types'
import { articleIdFromCanonicalUrl, asCandidateId, clipJobIdFromUrl, isCandidateId } from '../types'

export type CandidateDeliveryView = {
  readonly jobId: ClipJobId | null
  readonly runId: ClipRunId | null
  readonly selectedAt: string | null
  readonly articleId: ArticleId | null
  readonly deliveryState: CandidateDeliveryState
  readonly deliveryError: ClipJobError | null
  readonly availableInOpds: boolean
}

const STALE_JOB_ERROR: ClipJobError = {
  code: 'internal_error',
  message: '準備が中断されました。再試行できます',
}

export function emptyCandidateDelivery(candidate: CandidateArticle): CandidateDeliveryView {
  return {
    jobId: candidate.clipJobId,
    runId: candidate.clipRunId,
    selectedAt: candidate.selectedAt,
    articleId: candidate.completedArticleId,
    deliveryState: 'unsent',
    deliveryError: null,
    availableInOpds: false,
  }
}

export function resolveCandidateDelivery(input: {
  readonly candidate: CandidateArticle
  readonly job: ClipJobRecord | null
  readonly articlePresent: boolean
  readonly articleId: ArticleId | null
  readonly nowMs: number
}): CandidateDeliveryView {
  const { candidate, job, articlePresent, articleId, nowMs } = input
  const jobId = job?.jobId ?? candidate.clipJobId
  const runId = job?.runId ?? candidate.clipRunId
  const selectedAt = candidate.selectedAt
  const base = {
    jobId,
    runId,
    selectedAt,
    articleId,
  }

  if (job !== null && (job.status === 'queued' || job.status === 'running')) {
    if (isActiveClipJob(job, nowMs)) {
      return {
        ...base,
        deliveryState: 'preparing',
        deliveryError: null,
        availableInOpds: false,
      }
    }
    return {
      ...base,
      deliveryState: 'failed',
      deliveryError: STALE_JOB_ERROR,
      availableInOpds: false,
    }
  }

  if (job?.status === 'failed') {
    return {
      ...base,
      deliveryState: 'failed',
      deliveryError: job.error,
      availableInOpds: false,
    }
  }

  if (articlePresent && articleId !== null) {
    return {
      ...base,
      articleId,
      deliveryState: 'available',
      deliveryError: null,
      availableInOpds: true,
    }
  }

  if (job?.status === 'ready' && !articlePresent) {
    return {
      ...base,
      deliveryState: 'failed',
      deliveryError: { code: 'epub_failed', message: '完成記事の EPUB がありません' },
      availableInOpds: false,
    }
  }

  return {
    ...base,
    deliveryState: 'unsent',
    deliveryError: null,
    availableInOpds: false,
  }
}

async function articlePresent(
  store: ArticleStore,
  articleId: ArticleId | null,
): Promise<{ readonly present: boolean; readonly articleId: ArticleId | null }> {
  if (articleId === null) {
    return { present: false, articleId: null }
  }
  const meta = await store.getMeta(articleId)
  if (meta === null) {
    return { present: false, articleId }
  }
  const epub = await store.getEpub(articleId)
  return { present: epub !== null, articleId }
}

export async function loadCandidateDelivery(
  candidate: CandidateArticle,
  articleStore: ArticleStore,
  nowMs: number,
): Promise<CandidateDeliveryView> {
  const derivedJobId = candidate.clipJobId ?? (await clipJobIdFromUrl(candidate.canonicalUrl))
  const job = await articleStore.getJob(derivedJobId)
  const readyId = job?.status === 'ready' ? job.articleId : null
  const linkedId = readyId ?? candidate.completedArticleId
  const linked = await articlePresent(articleStore, linkedId)
  if (linked.present) {
    return resolveCandidateDelivery({
      candidate,
      job,
      articlePresent: true,
      articleId: linked.articleId,
      nowMs,
    })
  }
  const canonicalId = await articleIdFromCanonicalUrl(candidate.canonicalUrl)
  const canonical = canonicalId === linkedId ? linked : await articlePresent(articleStore, canonicalId)
  return resolveCandidateDelivery({
    candidate,
    job,
    articlePresent: canonical.present,
    articleId: canonical.present ? canonical.articleId : linked.articleId,
    nowMs,
  })
}

export function toCandidatePublic(
  candidate: CandidateArticle,
  delivery: CandidateDeliveryView = emptyCandidateDelivery(candidate),
): CandidatePublic {
  return {
    id: candidate.id,
    canonicalUrl: candidate.canonicalUrl,
    sourceUrl: candidate.sourceUrl,
    title: candidate.title,
    outlet: candidate.outlet,
    publishedAt: candidate.publishedAt,
    discoveredAt: candidate.discoveredAt,
    fetchStatus: candidate.fetchStatus,
    listingState: candidate.listingState,
    exclusionReason: candidate.exclusionReason,
    fullTextState: candidate.fullTextState,
    completedArticleId: delivery.articleId ?? candidate.completedArticleId,
    clipJobId: delivery.jobId,
    clipRunId: delivery.runId,
    selectedAt: delivery.selectedAt,
    deliveryState: delivery.deliveryState,
    deliveryError: delivery.deliveryError,
    availableInOpds: delivery.availableInOpds,
  }
}

export async function enrichCandidatePublic(
  candidate: CandidateArticle,
  articleStore: ArticleStore,
  nowMs: number,
): Promise<CandidatePublic> {
  const delivery = await loadCandidateDelivery(candidate, articleStore, nowMs)
  return toCandidatePublic(candidate, delivery)
}

export async function syncCandidateCompletion(
  candidate: CandidateArticle,
  publicItem: CandidatePublic,
  store: CandidateStore,
  now: Date,
): Promise<void> {
  if (publicItem.deliveryState !== 'available' || publicItem.completedArticleId === null) {
    return
  }
  if (
    candidate.completedArticleId === publicItem.completedArticleId &&
    candidate.clipJobId === publicItem.clipJobId &&
    candidate.clipRunId === publicItem.clipRunId
  ) {
    return
  }
  try {
    await store.put({
      ...candidate,
      completedArticleId: publicItem.completedArticleId,
      clipJobId: publicItem.clipJobId,
      clipRunId: publicItem.clipRunId,
      updatedAt: now.toISOString(),
    })
  } catch {
    return
  }
}

export function candidateCanSend(item: CandidatePublic): boolean {
  return (
    item.listingState === 'listed' &&
    item.exclusionReason === null &&
    item.fetchStatus === 'fetched' &&
    item.fullTextState !== 'unavailable' &&
    (item.deliveryState === 'unsent' || item.deliveryState === 'failed')
  )
}

export function candidateCanRegenerate(item: CandidatePublic): boolean {
  return item.deliveryState === 'available' && item.fetchStatus === 'fetched' && item.fullTextState !== 'unavailable'
}

export function candidateIdParam(raw: string | undefined): CandidateId | null {
  if (raw === undefined || !isCandidateId(raw)) {
    return null
  }
  return asCandidateId(raw)
}
