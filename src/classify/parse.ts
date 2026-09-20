import type { ArticleClassification, ArticleMeta, ArticleWrite } from '../types'
import {
  attemptedClassification,
  isArticleKind,
  isArticleTopic,
  isClassificationStatus,
  isClassifyErrorCode,
  isDecidedKind,
  isDecidedTopic,
  unavailableClassification,
} from './taxonomy'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asLabel<T extends string>(value: unknown, isAllowed: (value: string) => value is T): T | null {
  return typeof value === 'string' && isAllowed(value) ? value : null
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseArticleClassification(value: unknown): ArticleClassification {
  if (!isRecord(value)) {
    return unavailableClassification('skipped')
  }
  const status = asLabel(value.status, isClassificationStatus)
  const topic = asLabel(value.topic, isArticleTopic)
  const kind = asLabel(value.kind, isArticleKind)
  if (status === null || topic === null || kind === null) {
    return unavailableClassification('skipped')
  }
  const durationMs = asFinite(value.durationMs) ?? 0
  if (status === 'skipped') {
    return unavailableClassification('skipped', durationMs)
  }
  if (status === 'failed') {
    return unavailableClassification(
      'failed',
      durationMs,
      asLabel(value.errorCode, isClassifyErrorCode) ?? 'classify_internal',
    )
  }
  return attemptedClassification({
    model: asNonEmptyString(value.model),
    durationMs,
    inputTokens: asFinite(value.inputTokens),
    decidedTopic: asLabel(value.decidedTopic, isDecidedTopic) ?? asLabel(topic, isDecidedTopic),
    decidedKind: asLabel(value.decidedKind, isDecidedKind) ?? asLabel(kind, isDecidedKind),
    topicConfidence: asFinite(value.topicConfidence),
    kindConfidence: asFinite(value.kindConfidence),
  })
}

export function articleMetaFromWrite(
  article: ArticleWrite,
  existing: ArticleMeta | null,
  now: string,
): ArticleMeta {
  return {
    id: article.id,
    title: article.title,
    author: article.author,
    publishedAt: article.publishedAt,
    sourceUrl: article.sourceUrl,
    canonicalUrl: article.canonicalUrl,
    language: article.language,
    translated: article.translated,
    classification: article.classification ?? unavailableClassification('skipped'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export function articleMetaWithClassification(
  existing: ArticleMeta,
  classification: ArticleClassification,
  now: string,
): ArticleMeta {
  return {
    ...existing,
    classification,
    updatedAt: now,
  }
}
