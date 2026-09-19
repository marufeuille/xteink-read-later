import {
  asArticleId,
  asClipJobId,
  httpStatusByErrorKind,
  isArticleId,
  isClipJobId,
  parseHttpUrl,
  type ClipJobError,
  type ClipJobRecord,
  type ClipJobStatus,
  type ErrorKind,
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
  const jobId = asClipJobId(value.jobId)
  if (value.status === 'ready') {
    if (typeof value.articleId !== 'string' || !isArticleId(value.articleId) || value.error !== null) {
      return null
    }
    return {
      jobId,
      sourceUrl,
      status: 'ready',
      articleId: asArticleId(value.articleId),
      error: null,
      attempt: value.attempt,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
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
    return {
      jobId,
      sourceUrl,
      status: 'failed',
      articleId: null,
      error,
      attempt: value.attempt,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }
  }
  if (value.error !== null) {
    return null
  }
  return {
    jobId,
    sourceUrl,
    status: value.status,
    articleId: null,
    error: null,
    attempt: value.attempt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}
