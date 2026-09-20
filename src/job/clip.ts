import type { ClipJobRecord, ClipQueuedJob, ClipRunningJob, ClipRunId } from '../types'

export const CLIP_JOB_STALE_MS = 15 * 60 * 1000

function isClipJobInFlight(job: ClipJobRecord): job is ClipQueuedJob | ClipRunningJob {
  return job.status === 'queued' || job.status === 'running'
}

export function isClipJobStale(job: ClipJobRecord, nowMs: number): boolean {
  if (!isClipJobInFlight(job)) {
    return false
  }
  const updatedMs = Date.parse(job.updatedAt)
  return !Number.isFinite(updatedMs) || nowMs - updatedMs >= CLIP_JOB_STALE_MS
}

export function isActiveClipJob(
  job: ClipJobRecord | null,
  nowMs: number,
): job is ClipQueuedJob | ClipRunningJob {
  return job !== null && isClipJobInFlight(job) && !isClipJobStale(job, nowMs)
}

export function shouldProcessClipRun(job: ClipJobRecord | null, runId: ClipRunId): boolean {
  if (job === null) {
    return true
  }
  if (job.runId !== runId) {
    return false
  }
  if (job.status === 'ready') {
    return false
  }
  if (job.status === 'failed') {
    return job.error.code === 'queue_failed'
  }
  return true
}
