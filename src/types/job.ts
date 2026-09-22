import type { ErrorKind } from './errors'
import type { PipelineStage } from './http'
import type { ArticleId, ClipJobId, ClipRunId, HttpUrl } from './id'

export type ClipJobStatus = 'queued' | 'running' | 'ready' | 'failed'

export type ClipJobError = {
  readonly code: ErrorKind
  readonly message: string
}

/** One pipeline stage kept on the job. No URL, body, or token. */
export type ClipStageRecord = {
  readonly stage: PipelineStage
  readonly durationMs: number
  readonly attempt: number
  readonly errorKind?: string
}

type ClipJobBase = {
  readonly jobId: ClipJobId
  readonly runId: ClipRunId
  readonly sourceUrl: HttpUrl
  readonly attempt: number
  readonly stages: readonly ClipStageRecord[]
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
  readonly runId: ClipRunId
  readonly url: HttpUrl
}

export type PipelineLogContext = {
  readonly jobId: ClipJobId
  readonly runId?: ClipRunId
  readonly attempt?: number
  /** Mutable log for this attempt. `logPipeline` appends here; the job stores a copy. */
  readonly stages?: ClipStageRecord[]
}
