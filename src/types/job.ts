import type { ErrorKind } from './errors'
import type { ArticleId, ClipJobId, HttpUrl } from './id'

export type ClipJobStatus = 'queued' | 'running' | 'ready' | 'failed'

export type ClipJobError = {
  readonly code: ErrorKind
  readonly message: string
}

type ClipJobBase = {
  readonly jobId: ClipJobId
  readonly sourceUrl: HttpUrl
  readonly attempt: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type ClipQueuedJob = ClipJobBase & {
  readonly status: 'queued'
  readonly articleId: null
  readonly error: null
}

export type ClipRunningJob = ClipJobBase & {
  readonly status: 'running'
  readonly articleId: null
  readonly error: null
}

export type ClipReadyJob = ClipJobBase & {
  readonly status: 'ready'
  readonly articleId: ArticleId
  readonly error: null
}

export type ClipFailedJob = ClipJobBase & {
  readonly status: 'failed'
  readonly articleId: null
  readonly error: ClipJobError
}

export type ClipJobRecord = ClipQueuedJob | ClipRunningJob | ClipReadyJob | ClipFailedJob

export type ClipQueueMessage = {
  readonly jobId: ClipJobId
  readonly url: HttpUrl
}
