import { compareRecentJobs, recentClipLimit } from '../clip/recent'
import {
  articleEpubKey,
  articleMetaKey,
  asArticleId,
  asEpubBytes,
  clipCheckpointKey,
  clipJobKey,
  isArticleId,
  isClipJobId,
  parseHttpUrl,
  type ArticleId,
  type ArticleMeta,
  type ArticleStore,
  type ClipJobRecord,
  type CreateArticleStore,
} from '../types'
import {
  articleMetaFromWrite,
  articleMetaWithClassification,
  parseArticleClassification,
} from '../classify/parse'
import { logPipeline } from '../log'
import { parseClipCheckpoint } from './checkpoint'
import { parseClipJobRecord } from './job'

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clipInstant(value: unknown, createdAt: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : createdAt
}

const JSON_HTTP_METADATA = { httpMetadata: { contentType: 'application/json; charset=utf-8' } }

const CLIP_JOB_OBJECT_KEY = /^jobs\/(job_[a-f0-9]{32})\.json$/

function isClipJobObjectKey(key: string): boolean {
  const match = CLIP_JOB_OBJECT_KEY.exec(key)
  return match?.[1] !== undefined && isClipJobId(match[1])
}

function recentObjectStamp(object: R2Object): string {
  const updatedAt = object.customMetadata?.updatedAt
  if (updatedAt !== undefined && updatedAt.length > 0) {
    return updatedAt
  }
  return object.uploaded.toISOString()
}

function compareRecentObjects(a: R2Object, b: R2Object): number {
  const stampA = recentObjectStamp(a)
  const stampB = recentObjectStamp(b)
  if (stampA !== stampB) {
    return stampA < stampB ? 1 : -1
  }
  if (a.key === b.key) {
    return 0
  }
  return a.key < b.key ? -1 : 1
}

async function listClipJobObjects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({
      prefix: 'jobs/',
      include: ['customMetadata'],
      ...(cursor !== undefined ? { cursor } : {}),
    })
    for (const object of page.objects) {
      if (isClipJobObjectKey(object.key)) {
        objects.push(object)
      }
    }
    if (!page.truncated) {
      break
    }
    cursor = page.cursor
  }
  return objects
}

async function writeArticleMeta(bucket: R2Bucket, meta: ArticleMeta): Promise<void> {
  await bucket.put(articleMetaKey(meta.id), JSON.stringify(meta), JSON_HTTP_METADATA)
}

export function parseArticleMeta(value: unknown): ArticleMeta | null {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.id !== 'string' || !isArticleId(value.id)) {
    return null
  }
  if (typeof value.title !== 'string') {
    return null
  }
  const sourceUrl = typeof value.sourceUrl === 'string' ? parseHttpUrl(value.sourceUrl) : null
  const canonicalUrl = typeof value.canonicalUrl === 'string' ? parseHttpUrl(value.canonicalUrl) : null
  if (sourceUrl === null || canonicalUrl === null) {
    return null
  }
  if (value.language !== 'ja' || typeof value.translated !== 'boolean') {
    return null
  }
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    return null
  }
  const author = value.author === null || typeof value.author === 'string' ? value.author : null
  const publishedAt =
    value.publishedAt === null || typeof value.publishedAt === 'string' ? value.publishedAt : null
  return {
    id: asArticleId(value.id),
    title: value.title,
    author,
    publishedAt,
    sourceUrl,
    canonicalUrl,
    language: 'ja',
    translated: value.translated,
    classification: parseArticleClassification(value.classification),
    createdAt: value.createdAt,
    clippedAt: clipInstant(value.clippedAt, value.createdAt),
    updatedAt: value.updatedAt,
  }
}

async function listArticleKeys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({
      prefix: 'articles/',
      ...(cursor !== undefined ? { cursor } : {}),
    })
    for (const object of page.objects) {
      keys.push(object.key)
    }
    if (!page.truncated) {
      break
    }
    cursor = page.cursor
  }
  return keys
}

function articleIdFromObjectKey(key: string): { id: ArticleId; kind: 'meta' | 'epub' } | null {
  const parts = key.split('/')
  if (parts.length !== 3) {
    return null
  }
  const [prefix, id, file] = parts
  if (prefix !== 'articles' || id === undefined || file === undefined || !isArticleId(id)) {
    return null
  }
  if (file === 'meta.json') {
    return { id: asArticleId(id), kind: 'meta' }
  }
  if (file === 'book.epub') {
    return { id: asArticleId(id), kind: 'epub' }
  }
  return null
}

function publishableMetaKeys(objectKeys: readonly string[]): string[] {
  const metaIds = new Set<ArticleId>()
  const epubIds = new Set<ArticleId>()
  for (const key of objectKeys) {
    const parsed = articleIdFromObjectKey(key)
    if (parsed === null) {
      continue
    }
    if (parsed.kind === 'meta') {
      metaIds.add(parsed.id)
    } else {
      epubIds.add(parsed.id)
    }
  }
  return [...metaIds].filter((id) => epubIds.has(id)).map(articleMetaKey)
}

export const createR2Store: CreateArticleStore = (deps) => {
  const bucket = deps.ARTICLES

  const store: ArticleStore = {
    async getMeta(id) {
      const object = await bucket.get(articleMetaKey(id))
      if (object === null) {
        return null
      }
      try {
        return parseArticleMeta(await object.json())
      } catch {
        return null
      }
    },
    async getEpub(id) {
      const object = await bucket.get(articleEpubKey(id))
      if (object === null) {
        return null
      }
      return asEpubBytes(new Uint8Array(await object.arrayBuffer()))
    },
    async put(article, log) {
      const started = Date.now()
      const meta = articleMetaFromWrite(article, await store.getMeta(article.id), nowIso())
      await bucket.put(articleEpubKey(article.id), article.epub, {
        httpMetadata: { contentType: 'application/epub+zip' },
      })
      await writeArticleMeta(bucket, meta)
      logPipeline({ articleId: article.id, stage: 'store', durationMs: Date.now() - started }, log)
      return meta
    },
    async putClassification(id, classification) {
      const existing = await store.getMeta(id)
      if (existing === null) {
        return null
      }
      const meta = articleMetaWithClassification(existing, classification, nowIso())
      await writeArticleMeta(bucket, meta)
      return meta
    },
    async delete(id) {
      const metaKey = articleMetaKey(id)
      const epubKey = articleEpubKey(id)
      const [meta, epub] = await Promise.all([bucket.head(metaKey), bucket.head(epubKey)])
      await bucket.delete([metaKey, epubKey])
      return meta !== null || epub !== null
    },
    async listMeta() {
      const keys = publishableMetaKeys(await listArticleKeys(bucket))
      const metas: ArticleMeta[] = []
      for (const key of keys) {
        const object = await bucket.get(key)
        if (object === null) {
          continue
        }
        try {
          const parsed = parseArticleMeta(await object.json())
          if (parsed !== null) {
            metas.push(parsed)
          }
        } catch {
          continue
        }
      }
      return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    },
    async getJob(id) {
      const object = await bucket.get(clipJobKey(id))
      if (object === null) {
        return null
      }
      try {
        return parseClipJobRecord(await object.json())
      } catch {
        return null
      }
    },
    async putJob(job) {
      await bucket.put(clipJobKey(job.jobId), JSON.stringify(job), {
        ...JSON_HTTP_METADATA,
        customMetadata: { updatedAt: job.updatedAt },
      })
    },
    async listRecentJobs(limit) {
      const capped = recentClipLimit(limit)
      if (capped === 0) {
        return []
      }
      const selected = (await listClipJobObjects(bucket)).sort(compareRecentObjects)
      const jobs: ClipJobRecord[] = []
      for (const object of selected) {
        if (jobs.length >= capped) {
          break
        }
        const body = await bucket.get(object.key)
        if (body === null) {
          continue
        }
        try {
          const parsed = parseClipJobRecord(await body.json())
          if (parsed !== null) {
            jobs.push(parsed)
          }
        } catch {
          continue
        }
      }
      return jobs.sort(compareRecentJobs)
    },
    async getClipCheckpoint(id) {
      const object = await bucket.get(clipCheckpointKey(id))
      if (object === null) {
        return null
      }
      try {
        const parsed = parseClipCheckpoint(await object.json())
        return parsed !== null && parsed.jobId === id ? parsed : null
      } catch {
        return null
      }
    },
    async putClipCheckpoint(checkpoint) {
      await bucket.put(clipCheckpointKey(checkpoint.jobId), JSON.stringify(checkpoint), JSON_HTTP_METADATA)
    },
    async deleteClipCheckpoint(id) {
      await bucket.delete([clipCheckpointKey(id)])
    },
  }
  return store
}
