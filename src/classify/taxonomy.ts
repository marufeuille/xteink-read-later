import type {
  ArticleKind,
  ArticleTopic,
  ClassificationStatus,
  ClassificationVersion,
  ClassifiedClassification,
  ClassifyErrorCode,
  DecidedArticleKind,
  DecidedArticleTopic,
  FailedClassification,
  LowConfidenceClassification,
  SkippedClassification,
} from '../types'

export const CLASSIFICATION_VERSION: ClassificationVersion = 'topic-kind-v1'
export const CLASSIFY_MIN_CONFIDENCE = 0.7
export const CLASSIFY_MAX_EXCERPT_CHARS = 6_000
export const CLASSIFY_MAX_HTML_CHARS = 16_000

export const ARTICLE_TOPIC_CRITERIA: Readonly<Record<DecidedArticleTopic, string>> = {
  tech: 'ソフトウェア、プログラミング、クラウド、インフラ、ガジェット、工学',
  science: '自然科学、医学、学術研究',
  society: '政治、経済、社会問題、法律',
  culture: '本、映画、音楽、ゲーム、アート、エンタメ',
  life: '仕事術、健康、旅行、日常、個人の経験',
}

export const ARTICLE_KIND_CRITERIA: Readonly<Record<DecidedArticleKind, string>> = {
  explainer: '解説、ハウツー、チュートリアル、技術ドキュメント',
  news: 'ニュース、速報、製品発表、リリースノート',
  essay: 'エッセイ、意見、体験談、コラム',
}

export const CLASSIFICATION_STATUSES = [
  'classified',
  'low_confidence',
  'skipped',
  'failed',
] as const satisfies readonly ClassificationStatus[]

export const CLASSIFY_ERROR_CODES = [
  'classify_http',
  'classify_timeout',
  'classify_invalid_payload',
  'classify_internal',
] as const satisfies readonly ClassifyErrorCode[]

const DECIDED_TOPICS = new Set<string>(Object.keys(ARTICLE_TOPIC_CRITERIA))
const DECIDED_KINDS = new Set<string>(Object.keys(ARTICLE_KIND_CRITERIA))
const CLASSIFY_ERROR_CODE_SET = new Set<string>(CLASSIFY_ERROR_CODES)
const CLASSIFICATION_STATUS_SET = new Set<string>(CLASSIFICATION_STATUSES)

export function isDecidedTopic(value: string): value is DecidedArticleTopic {
  return DECIDED_TOPICS.has(value)
}

export function isDecidedKind(value: string): value is DecidedArticleKind {
  return DECIDED_KINDS.has(value)
}

export function isArticleTopic(value: string): value is ArticleTopic {
  return isDecidedTopic(value) || value === 'uncategorized'
}

export function isArticleKind(value: string): value is ArticleKind {
  return isDecidedKind(value) || value === 'uncategorized'
}

export function isClassifyErrorCode(value: string): value is ClassifyErrorCode {
  return CLASSIFY_ERROR_CODE_SET.has(value)
}

export function isClassificationStatus(value: string): value is ClassificationStatus {
  return CLASSIFICATION_STATUS_SET.has(value)
}

function durationMsOf(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
}

type ClassifiedInput = Pick<
  ClassifiedClassification,
  'model' | 'durationMs' | 'inputTokens' | 'topic' | 'kind' | 'topicConfidence' | 'kindConfidence'
>

type LowConfidenceInput = Pick<
  LowConfidenceClassification,
  | 'model'
  | 'durationMs'
  | 'inputTokens'
  | 'topic'
  | 'kind'
  | 'decidedTopic'
  | 'decidedKind'
  | 'topicConfidence'
  | 'kindConfidence'
>

type AttemptedInput = Omit<LowConfidenceInput, 'topic' | 'kind'>

export function unavailableClassification(status: 'skipped', durationMs?: number): SkippedClassification
export function unavailableClassification(
  status: 'failed',
  durationMs?: number,
  errorCode?: ClassifyErrorCode,
): FailedClassification
export function unavailableClassification(
  status: Extract<ClassificationStatus, 'skipped' | 'failed'>,
  durationMs = 0,
  errorCode: ClassifyErrorCode = 'classify_internal',
): SkippedClassification | FailedClassification {
  const unavailable = {
    version: CLASSIFICATION_VERSION,
    durationMs: durationMsOf(durationMs),
    model: null,
    inputTokens: null,
    topic: 'uncategorized',
    kind: 'uncategorized',
    decidedTopic: null,
    decidedKind: null,
    topicConfidence: null,
    kindConfidence: null,
  } as const
  return status === 'skipped'
    ? { ...unavailable, status, errorCode: null }
    : { ...unavailable, status, errorCode }
}

export function classifiedClassification(input: ClassifiedInput): ClassifiedClassification {
  return {
    ...input,
    version: CLASSIFICATION_VERSION,
    status: 'classified',
    durationMs: durationMsOf(input.durationMs),
    decidedTopic: input.topic,
    decidedKind: input.kind,
    errorCode: null,
  }
}

export function lowConfidenceClassification(input: LowConfidenceInput): LowConfidenceClassification {
  return {
    ...input,
    version: CLASSIFICATION_VERSION,
    status: 'low_confidence',
    durationMs: durationMsOf(input.durationMs),
    errorCode: null,
  }
}

export function attemptedClassification(input: AttemptedInput): ClassifiedClassification | LowConfidenceClassification {
  const topic = shelfChoice(input.decidedTopic, input.topicConfidence)
  const kind = shelfChoice(input.decidedKind, input.kindConfidence)
  if (
    input.model === null ||
    input.topicConfidence === null ||
    input.kindConfidence === null ||
    !isDecidedTopic(topic) ||
    !isDecidedKind(kind)
  ) {
    return lowConfidenceClassification({
      ...input,
      topic,
      kind,
    })
  }
  return classifiedClassification({
    model: input.model,
    durationMs: input.durationMs,
    inputTokens: input.inputTokens,
    topic,
    kind,
    topicConfidence: input.topicConfidence,
    kindConfidence: input.kindConfidence,
  })
}

export function shelfChoice<T extends DecidedArticleTopic | DecidedArticleKind>(
  decided: T | null,
  confidence: number | null,
): T | 'uncategorized' {
  return decided !== null &&
    confidence !== null &&
    Number.isFinite(confidence) &&
    confidence >= CLASSIFY_MIN_CONFIDENCE
    ? decided
    : 'uncategorized'
}
