import type { ClipJobBody, ClipJobRecord, ClipJobStageBody, ClipQueuedBody } from '../types'
import { articleEpubKey } from '../types'

function stageBodies(job: ClipJobRecord): readonly ClipJobStageBody[] {
  return job.stages.map((stage) => ({
    stage: stage.stage,
    durationMs: stage.durationMs,
    attempt: stage.attempt,
    ...(stage.errorKind === undefined ? {} : { errorKind: stage.errorKind }),
  }))
}

export function toClipQueuedBody(job: ClipJobRecord): ClipQueuedBody {
  return {
    jobId: job.jobId,
    status: 'queued',
    sourceUrl: job.sourceUrl,
  }
}

export function toClipJobBody(job: ClipJobRecord): ClipJobBody {
  const stages = stageBodies(job)
  if (job.status === 'ready') {
    return {
      jobId: job.jobId,
      status: 'ready',
      sourceUrl: job.sourceUrl,
      id: job.articleId,
      epubPath: `/${articleEpubKey(job.articleId)}`,
      stages,
    }
  }
  if (job.status === 'failed') {
    return {
      jobId: job.jobId,
      status: 'failed',
      sourceUrl: job.sourceUrl,
      error: {
        code: job.error.code,
        message: job.error.message,
      },
      stages,
    }
  }
  return {
    jobId: job.jobId,
    status: job.status,
    sourceUrl: job.sourceUrl,
    attempt: job.attempt,
    stages,
  }
}
