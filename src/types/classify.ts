import type { TranslatedArticle } from './article'
import type { EvaluateSystemOne, JevDeps } from './jev'

export type DecidedArticleTopic = 'tech' | 'science' | 'society' | 'culture' | 'life'
export type DecidedArticleKind = 'explainer' | 'news' | 'essay'
export type ArticleTopic = DecidedArticleTopic | 'uncategorized'
export type ArticleKind = DecidedArticleKind | 'uncategorized'

export type ClassificationVersion = 'topic-kind-v1'
export type ClassificationStatus = 'classified' | 'low_confidence' | 'skipped' | 'failed'

export type ClassifyErrorCode =
  | 'classify_http'
  | 'classify_timeout'
  | 'classify_invalid_payload'
  | 'classify_internal'

type ClassificationBase = {
  readonly version: ClassificationVersion
  readonly durationMs: number
}

type UnavailableClassification = ClassificationBase & {
  readonly model: null
  readonly inputTokens: null
  readonly topic: 'uncategorized'
  readonly kind: 'uncategorized'
  readonly decidedTopic: null
  readonly decidedKind: null
  readonly topicConfidence: null
  readonly kindConfidence: null
}

export type ClassifiedClassification = ClassificationBase & {
  readonly status: 'classified'
  readonly model: string
  readonly inputTokens: number | null
  readonly topic: DecidedArticleTopic
  readonly kind: DecidedArticleKind
  readonly decidedTopic: DecidedArticleTopic
  readonly decidedKind: DecidedArticleKind
  readonly topicConfidence: number
  readonly kindConfidence: number
  readonly errorCode: null
}

export type LowConfidenceClassification = ClassificationBase & {
  readonly status: 'low_confidence'
  readonly model: string | null
  readonly inputTokens: number | null
  readonly topic: ArticleTopic
  readonly kind: ArticleKind
  readonly decidedTopic: DecidedArticleTopic | null
  readonly decidedKind: DecidedArticleKind | null
  readonly topicConfidence: number | null
  readonly kindConfidence: number | null
  readonly errorCode: null
}

export type SkippedClassification = UnavailableClassification & {
  readonly status: 'skipped'
  readonly errorCode: null
}

export type FailedClassification = UnavailableClassification & {
  readonly status: 'failed'
  readonly errorCode: ClassifyErrorCode
}

export type ArticleClassification =
  | ClassifiedClassification
  | LowConfidenceClassification
  | SkippedClassification
  | FailedClassification

export type ClassifyArticle = (
  article: TranslatedArticle,
  deps: JevDeps,
  evaluate?: EvaluateSystemOne,
) => Promise<ArticleClassification>
