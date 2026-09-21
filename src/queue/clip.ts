import { classifyArticle as defaultClassifyArticle } from '../classify/article'
import { unavailableClassification } from '../classify/taxonomy'
import { errorMessage } from '../http/error-response'
import { shouldProcessClipRun } from '../job/clip'
import { logPipeline } from '../log'
import { clipPipeline as defaultClipPipeline } from '../pipeline/clip'
import { createR2Store } from '../store/r2'
import type {
  ArticleClassification,
  ArticleId,
  ArticleStore,
  ArticleWrite,
  ClassifyArticle,
  ClipJobId,
  ClipJobRecord,
  ClipPipeline,
  ClipQueueMessage,
  ClipRunId,
  CreateArticleStore,
  EpubBytes,
  PipelineError,
  PipelineLogContext,
  TranslatedArticle,
} from '../types'
import { isClipJobId, isClipRunId, parseHttpUrl } from '../types'

export const CLIP_QUEUE_MAX_RETRIES = 3
export const CLIP_QUEUE_NAME = 'xteink-read-later-clip'

export type ClipQueueHandlerDeps = {
  readonly clipPipeline?: ClipPipeline
  readonly classifyArticle?: ClassifyArticle
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
  if (!('jobId' in body) || !('runId' in body) || !('url' in body)) {
    return null
  }
  if (typeof body.jobId !== 'string' || !isClipJobId(body.jobId)) {
    return null
  }
  if (typeof body.runId !== 'string' || !isClipRunId(body.runId)) {
    return null
  }
  if (typeof body.url !== 'string') {
    return null
  }
  const url = parseHttpUrl(body.url)
  if (url === null) {
    return null
  }
  return { jobId: body.jobId, runId: body.runId, url }
}

export function shouldRetryClipAttempt(attempts: number): boolean {
  return attempts <= CLIP_QUEUE_MAX_RETRIES
}

export function shouldRetryClipError(kind: PipelineError['kind'], attempts: number): boolean {
  if (!shouldRetryClipAttempt(attempts)) {
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

function jobFields(
  message: ClipQueueMessage,
  existing: ClipJobRecord | null,
  attempts: number,
): Pick<ClipJobRecord, 'jobId' | 'runId' | 'sourceUrl' | 'attempt' | 'createdAt'> {
  return {
    jobId: message.jobId,
    runId: message.runId,
    sourceUrl: existing?.sourceUrl ?? message.url,
    attempt: attempts,
    createdAt: existing?.createdAt ?? nowIso(),
  }
}

async function currentRunId(store: ArticleStore, jobId: ClipJobId): Promise<ClipRunId | null> {
  return (await store.getJob(jobId))?.runId ?? null
}

async function classifyQueuedArticle(
  article: TranslatedArticle,
  env: Cloudflare.Env,
  classify: ClassifyArticle,
  articleId: ArticleId,
  log: PipelineLogContext,
): Promise<ArticleClassification> {
  const started = Date.now()
  let classification: ArticleClassification
  try {
    classification = await classify(article, { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY })
  } catch {
    classification = unavailableClassification('failed', Date.now() - started, 'classify_internal')
  }
  const errorKind = classification.status === 'failed' ? classification.errorCode : undefined
  logPipeline(
    {
      articleId,
      stage: 'classify',
      durationMs: Date.now() - started,
      ...(errorKind === undefined ? {} : { errorKind }),
    },
    log,
  )
  return classification
}

function clipArticleWrite(id: ArticleId, article: TranslatedArticle, epub: EpubBytes): ArticleWrite {
  return {
    id,
    title: article.title,
    author: article.author,
    publishedAt: article.publishedAt,
    sourceUrl: article.sourceUrl,
    canonicalUrl: article.canonicalUrl,
    language: article.language,
    translated: article.translated,
    classification: unavailableClassification('skipped'),
    epub,
  }
}

async function continueCurrentRunOrAck(
  store: ArticleStore,
  message: Message<ClipQueueMessage>,
  jobId: ClipJobId,
  runId: ClipRunId,
): Promise<boolean> {
  if ((await currentRunId(store, jobId)) === runId) {
    return true
  }
  message.ack()
  return false
}

async function putJobIfCurrentRun(store: ArticleStore, job: ClipJobRecord): Promise<boolean> {
  const current = await currentRunId(store, job.jobId)
  if (current !== null && current !== job.runId) {
    return false
  }
  await store.putJob(job)
  return true
}

async function putCurrentRunOrAck(
  store: ArticleStore,
  message: Message<ClipQueueMessage>,
  job: ClipJobRecord,
): Promise<boolean> {
  if (await putJobIfCurrentRun(store, job)) {
    return true
  }
  message.ack()
  return false
}

async function processMessage(
  message: Message<ClipQueueMessage>,
  env: Cloudflare.Env,
  deps: ClipQueueHandlerDeps,
): Promise<void> {
  const parsed = parseClipQueueMessage(message.body)
  if (parsed === null) {
    logPipeline({ stage: 'queue', durationMs: 0, errorKind: 'invalid_url' })
    message.ack()
    return
  }

  try {
    await runClipQueueMessage(message, parsed, env, deps)
  } catch {
    const store = storeFor(env, deps)
    const existing = await store.getJob(parsed.jobId)
    logPipeline(
      { stage: 'queue', durationMs: 0, errorKind: 'internal_error' },
      { jobId: parsed.jobId, runId: parsed.runId, attempt: message.attempts },
    )
    if (shouldRetryClipAttempt(message.attempts)) {
      message.retry()
      return
    }
    await putJobIfCurrentRun(store, {
      ...jobFields(parsed, existing, message.attempts),
      status: 'failed',
      articleId: null,
      error: {
        code: 'internal_error',
        message: 'Clip job failed after an unexpected error',
      },
      updatedAt: nowIso(),
    })
    message.ack()
  }
}

async function runClipQueueMessage(
  message: Message<ClipQueueMessage>,
  parsed: ClipQueueMessage,
  env: Cloudflare.Env,
  deps: ClipQueueHandlerDeps,
): Promise<void> {
  const { jobId, runId, url } = parsed
  const store = storeFor(env, deps)
  const pipeline = deps.clipPipeline ?? defaultClipPipeline
  const classify = deps.classifyArticle ?? defaultClassifyArticle
  const existing = await store.getJob(jobId)
  if (!shouldProcessClipRun(existing, runId)) {
    message.ack()
    return
  }

  const fields = jobFields(parsed, existing, message.attempts)
  const log = { jobId, runId, attempt: message.attempts }
  const started = Date.now()
  if (
    !(await putCurrentRunOrAck(store, message, {
      ...fields,
      status: 'running',
      articleId: null,
      error: null,
      updatedAt: nowIso(),
    }))
  ) {
    return
  }

  const result = await pipeline(url, { OPENAI_API_KEY: env.OPENAI_API_KEY }, log)
  if (result.ok) {
    const { id, article, epub } = result.value
    if (!(await continueCurrentRunOrAck(store, message, jobId, runId))) {
      return
    }
    await store.put(clipArticleWrite(id, article, epub), log)
    if (!(await continueCurrentRunOrAck(store, message, jobId, runId))) {
      return
    }
    const classification = await classifyQueuedArticle(article, env, classify, id, log)
    if (!(await continueCurrentRunOrAck(store, message, jobId, runId))) {
      return
    }
    if (classification.status !== 'skipped') {
      await store.putClassification(id, classification)
    }
    if (
      !(await putCurrentRunOrAck(store, message, {
        ...fields,
        status: 'ready',
        articleId: id,
        error: null,
        updatedAt: nowIso(),
      }))
    ) {
      return
    }
    logPipeline({ articleId: id, stage: 'queue', durationMs: Date.now() - started }, log)
    message.ack()
    return
  }

  const logQueueError = () =>
    logPipeline(
      { stage: 'queue', durationMs: Date.now() - started, errorKind: result.error.kind },
      log,
    )
  if (shouldRetryClipError(result.error.kind, message.attempts)) {
    logQueueError()
    message.retry()
    return
  }

  await putJobIfCurrentRun(store, {
    ...fields,
    status: 'failed',
    articleId: null,
    error: {
      code: result.error.kind,
      message: errorMessage(result.error),
    },
    updatedAt: nowIso(),
  })
  logQueueError()
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
