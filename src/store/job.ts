import {
  httpStatusByErrorKind,
  isArticleId,
  isClipJobId,
  isClipRunId,
  parseHttpUrl,
  PIPELINE_STAGES,
  type ClipJobError,
  type ClipJobRecord,
  type ClipJobStatus,
  type ClipStageRecord,
  type ErrorKind,
  type PipelineStage,
} from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClipJobStatus(value: unknown): value is ClipJobStatus {
  return value === 'queued' || value === 'running' || value === 'ready' || value === 'failed'
}

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && value in httpStatusByErrorKind
}

const STAGE_SET: ReadonlySet<string> = new Set(PIPELINE_STAGES)

function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && STAGE_SET.has(value)
}

function parseStages(value: unknown): ClipStageRecord[] {
  if (!Array.isArray(value)) {
    return []
  }
  const stages: ClipStageRecord[] = []
  for (const item of value) {
    if (!isRecord(item) || !isPipelineStage(item.stage)) {
      continue
    }
    if (typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0) {
      continue
    }
    if (typeof item.attempt !== 'number' || !Number.isInteger(item.attempt) || item.attempt < 0) {
      continue
    }
    if (item.errorKind !== undefined && typeof item.errorKind !== 'string') {
      continue
    }
    stages.push({
      stage: item.stage,
      durationMs: item.durationMs,
      attempt: item.attempt,
      ...(typeof item.errorKind === 'string' && item.errorKind.length > 0 ? { errorKind: item.errorKind } : {}),
    })
  }
  return stages
}

function parseClipJobError(value: unknown): ClipJobError | null {
  if (!isRecord(value)) {
    return null
  }
  if (!isErrorKind(value.code) || typeof value.message !== 'string') {
    return null
  }
  return { code: value.code, message: value.message }
}

export function parseClipJobRecord(value: unknown): ClipJobRecord | null {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.jobId !== 'string' || !isClipJobId(value.jobId)) {
    return null
  }
  if (typeof value.runId !== 'string' || !isClipRunId(value.runId)) {
    return null
  }
  const sourceUrl = typeof value.sourceUrl === 'string' ? parseHttpUrl(value.sourceUrl) : null
  if (sourceUrl === null || !isClipJobStatus(value.status)) {
    return null
  }
  if (typeof value.attempt !== 'number' || !Number.isInteger(value.attempt) || value.attempt < 0) {
    return null
  }
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    return null
  }
  const base = {
    jobId: value.jobId,
    runId: value.runId,
    sourceUrl,
    attempt: value.attempt,
    stages: parseStages(value.stages),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
  if (value.status === 'ready') {
    if (typeof value.articleId !== 'string' || !isArticleId(value.articleId) || value.error !== null) {
      return null
    }
    return {
      ...base,
      status: 'ready',
      articleId: value.articleId,
      error: null,
    }
  }
  if (value.articleId !== null) {
    return null
  }
  if (value.status === 'failed') {
    const error = parseClipJobError(value.error)
    if (error === null) {
      return null
    }
    return { ...base, status: 'failed', articleId: null, error }
  }
  if (value.error !== null) {
    return null
  }
  return { ...base, status: value.status, articleId: null, error: null }
}
