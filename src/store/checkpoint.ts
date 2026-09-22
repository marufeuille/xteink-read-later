import {
  isArticleId,
  isClipJobId,
  isClipRunId,
  parseHttpUrl,
  type ClipCheckpoint,
  type TranslatedArticle,
} from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTranslatedArticle(value: unknown): TranslatedArticle | null {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.contentHtml !== 'string') {
    return null
  }
  if (value.language !== 'ja' || typeof value.translated !== 'boolean') {
    return null
  }
  if (value.author !== null && typeof value.author !== 'string') {
    return null
  }
  if (value.publishedAt !== null && typeof value.publishedAt !== 'string') {
    return null
  }
  const sourceUrl = typeof value.sourceUrl === 'string' ? parseHttpUrl(value.sourceUrl) : null
  const canonicalUrl = typeof value.canonicalUrl === 'string' ? parseHttpUrl(value.canonicalUrl) : null
  if (sourceUrl === null || canonicalUrl === null) {
    return null
  }
  return {
    title: value.title,
    author: value.author,
    publishedAt: value.publishedAt,
    sourceUrl,
    canonicalUrl,
    contentHtml: value.contentHtml,
    language: 'ja',
    translated: value.translated,
  }
}

export function parseClipCheckpoint(value: unknown): ClipCheckpoint | null {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.jobId !== 'string' || !isClipJobId(value.jobId)) {
    return null
  }
  if (typeof value.runId !== 'string' || !isClipRunId(value.runId)) {
    return null
  }
  if (typeof value.articleId !== 'string' || !isArticleId(value.articleId)) {
    return null
  }
  const article = parseTranslatedArticle(value.article)
  if (article === null) {
    return null
  }
  return {
    jobId: value.jobId,
    runId: value.runId,
    articleId: value.articleId,
    article,
  }
}
