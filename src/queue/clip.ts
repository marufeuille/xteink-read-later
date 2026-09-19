import { errorMessage } from '../http/error-response'
import { logPipeline } from '../log'
import { clipPipeline as defaultClipPipeline } from '../pipeline/clip'
import { createR2Store } from '../store/r2'
import type {
  ArticleStore,
  ClipPipeline,
  ClipQueueMessage,
  CreateArticleStore,
  PipelineError,
} from '../types'
import { isClipJobId, parseHttpUrl } from '../types'

export const CLIP_QUEUE_MAX_RETRIES = 3

export type ClipQueueHandlerDeps = {
  readonly clipPipeline?: ClipPipeline
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
}

function nowIso(): string {
  return new Date().toISOString()
}

function storeFor(env: Cloudflare.Env, deps: ClipQueueHandlerDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  const create = deps.createStore ?? createR2Store
  return create(env)
}

export function parseClipQueueMessage(body: unknown): ClipQueueMessage | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  if (!('jobId' in body) || !('url' in body)) {
    return null
  }
  if (typeof body.jobId !== 'string' || !isClipJobId(body.jobId)) {
    return null
  }
  if (typeof body.url !== 'string') {
    return null
  }
  const url = parseHttpUrl(body.url)
  if (url === null) {
    return null
  }
  return { jobId: body.jobId, url }
}

export function shouldRetryClipError(kind: PipelineError['kind'], attempts: number): boolean {
  if (attempts > CLIP_QUEUE_MAX_RETRIES) {
    return false
  }
  switch (kind) {
    case 'translate_failed':
    case 'fetch_failed':
      return true
    case 'epub_failed':
      return attempts === 1
    case 'extract_failed':
    case 'payload_too_large':
    case 'invalid_url':
      return false
  }
}

async function processMessage(
  message: Message<ClipQueueMessage>,
  env: Cloudflare.Env,
  deps: ClipQueueHandlerDeps,
): Promise<void> {
  const parsed = parseClipQueueMessage(message.body)
  if (parsed === null) {
    logPipeline({
      stage: 'queue',
      durationMs: 0,
      errorKind: 'invalid_url',
    })
    message.ack()
    return
  }

  const { jobId, url } = parsed
  const store = storeFor(env, deps)
  const pipeline = deps.clipPipeline ?? defaultClipPipeline
  const existing = await store.getJob(jobId)
  const createdAt = existing?.createdAt ?? nowIso()
  const started = Date.now()

  await store.putJob({
    jobId,
    sourceUrl: existing?.sourceUrl ?? url,
    status: 'running',
    articleId: null,
    error: null,
    attempt: message.attempts,
    createdAt,
    updatedAt: nowIso(),
  })

  const result = await pipeline(url, { OPENAI_API_KEY: env.OPENAI_API_KEY })
  if (result.ok) {
    const { id, article, epub } = result.value
    await store.put({
      id,
      title: article.title,
      author: article.author,
      publishedAt: article.publishedAt,
      sourceUrl: article.sourceUrl,
      canonicalUrl: article.canonicalUrl,
      language: article.language,
      translated: article.translated,
      epub,
    })
    await store.putJob({
      jobId,
      sourceUrl: existing?.sourceUrl ?? url,
      status: 'ready',
      articleId: id,
      error: null,
      attempt: message.attempts,
      createdAt,
      updatedAt: nowIso(),
    })
    logPipeline({
      jobId,
      articleId: id,
      stage: 'queue',
      durationMs: Date.now() - started,
    })
    message.ack()
    return
  }

  if (shouldRetryClipError(result.error.kind, message.attempts)) {
    logPipeline({
      jobId,
      stage: 'queue',
      durationMs: Date.now() - started,
      errorKind: result.error.kind,
    })
    message.retry()
    return
  }

  await store.putJob({
    jobId,
    sourceUrl: existing?.sourceUrl ?? url,
    status: 'failed',
    articleId: null,
    error: {
      code: result.error.kind,
      message: errorMessage(result.error),
    },
    attempt: message.attempts,
    createdAt,
    updatedAt: nowIso(),
  })
  logPipeline({
    jobId,
    stage: 'queue',
    durationMs: Date.now() - started,
    errorKind: result.error.kind,
  })
  message.ack()
}

export function createClipQueueHandler(
  deps: ClipQueueHandlerDeps = {},
): (batch: MessageBatch<ClipQueueMessage>, env: Cloudflare.Env) => Promise<void> {
  return async (batch, env) => {
    for (const message of batch.messages) {
      await processMessage(message, env, deps)
    }
  }
}

export const handleClipQueue = createClipQueueHandler()
