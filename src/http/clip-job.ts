import type { ClipJobBody, ClipJobRecord, ClipQueuedBody } from '../types'
import { articleEpubKey } from '../types'

export function toClipQueuedBody(job: ClipJobRecord): ClipQueuedBody {
  return {
    jobId: job.jobId,
    status: 'queued',
    sourceUrl: job.sourceUrl,
  }
}

export function toClipJobBody(job: ClipJobRecord): ClipJobBody {
  if (job.status === 'ready') {
    return {
      jobId: job.jobId,
      status: 'ready',
      sourceUrl: job.sourceUrl,
      id: job.articleId,
      epubPath: `/${articleEpubKey(job.articleId)}`,
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
    }
  }
  return {
    jobId: job.jobId,
    status: job.status,
    sourceUrl: job.sourceUrl,
    attempt: job.attempt,
  }
}
