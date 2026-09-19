import {
  articleEpubKey,
  articleMetaKey,
  asArticleId,
  asEpubBytes,
  clipJobKey,
  isArticleId,
  parseHttpUrl,
  type ArticleMeta,
  type ArticleStore,
  type CreateArticleStore,
} from '../types'
import { logPipeline } from '../log'
import { parseClipJobRecord } from './job'

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

async function listMetaKeys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({
      prefix: 'articles/',
      ...(cursor !== undefined ? { cursor } : {}),
    })
    for (const object of page.objects) {
      if (object.key.endsWith('/meta.json')) {
        keys.push(object.key)
      }
    }
    if (!page.truncated) {
      break
    }
    cursor = page.cursor
  }
  return keys
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
    async put(article) {
      const started = Date.now()
      const existing = await store.getMeta(article.id)
      const meta: ArticleMeta = {
        id: article.id,
        title: article.title,
        author: article.author,
        publishedAt: article.publishedAt,
        sourceUrl: article.sourceUrl,
        canonicalUrl: article.canonicalUrl,
        language: article.language,
        translated: article.translated,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      }
      await bucket.put(articleMetaKey(article.id), JSON.stringify(meta), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      })
      await bucket.put(articleEpubKey(article.id), article.epub, {
        httpMetadata: { contentType: 'application/epub+zip' },
      })
      logPipeline({
        articleId: article.id,
        stage: 'store',
        durationMs: Date.now() - started,
      })
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
      const keys = await listMetaKeys(bucket)
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
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      })
    },
  }
  return store
}
