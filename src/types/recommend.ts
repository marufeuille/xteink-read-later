import type { EvaluateSystemOne, JevDeps } from './jev'

export type RecommendVersion = 'de-recommend-v1'

export const RECOMMEND_GRADES = ['recommended', 'related', 'low_priority'] as const
export type RecommendGrade = (typeof RECOMMEND_GRADES)[number]

export const RECOMMEND_STATUSES = [
  'unevaluated',
  'evaluated',
  'low_confidence',
  'insufficient_material',
  'skipped',
  'failed',
] as const
export type RecommendStatus = (typeof RECOMMEND_STATUSES)[number]

export const RECOMMEND_ERROR_CODES = [
  'recommend_http',
  'recommend_timeout',
  'recommend_invalid_payload',
  'recommend_internal',
] as const
export type RecommendErrorCode = (typeof RECOMMEND_ERROR_CODES)[number]

export const RECOMMEND_REASON_IDS = ['de_relevant', 'has_concreteness', 'has_verification'] as const
export type RecommendReasonId = (typeof RECOMMEND_REASON_IDS)[number]

type RecommendUnavailableAxes = {
  readonly grade: null
  readonly decidedGrade: null
  readonly confidence: null
  readonly model: null
  readonly relevant: null
  readonly concrete: null
  readonly verification: null
  readonly inputTokens: null
}

export type UnevaluatedRecommendation = RecommendUnavailableAxes & {
  readonly status: 'unevaluated'
  readonly version: null
  readonly excerptHash: null
  readonly evaluatedAt: null
  readonly errorCode: null
  readonly durationMs: 0
}

export type EvaluatedRecommendation = {
  readonly status: 'evaluated'
  readonly version: RecommendVersion
  readonly grade: RecommendGrade
  readonly decidedGrade: RecommendGrade
  readonly confidence: number
  readonly model: string
  readonly excerptHash: string
  readonly evaluatedAt: string
  readonly relevant: boolean
  readonly concrete: boolean
  readonly verification: boolean
  readonly errorCode: null
  readonly inputTokens: number | null
  readonly durationMs: number
}

export type LowConfidenceRecommendation = {
  readonly status: 'low_confidence'
  readonly version: RecommendVersion
  readonly grade: null
  readonly decidedGrade: RecommendGrade | null
  readonly confidence: number | null
  readonly model: string | null
  readonly excerptHash: string
  readonly evaluatedAt: string
  readonly relevant: boolean | null
  readonly concrete: boolean | null
  readonly verification: boolean | null
  readonly errorCode: null
  readonly inputTokens: number | null
  readonly durationMs: number
}

export type InsufficientRecommendation = RecommendUnavailableAxes & {
  readonly status: 'insufficient_material'
  readonly version: RecommendVersion
  readonly excerptHash: string | null
  readonly evaluatedAt: string
  readonly errorCode: null
  readonly durationMs: number
}

export type SkippedRecommendation = RecommendUnavailableAxes & {
  readonly status: 'skipped'
  readonly version: RecommendVersion
  readonly excerptHash: string
  readonly evaluatedAt: string
  readonly errorCode: null
  readonly durationMs: number
}

export type FailedRecommendation = RecommendUnavailableAxes & {
  readonly status: 'failed'
  readonly version: RecommendVersion
  readonly excerptHash: string | null
  readonly evaluatedAt: string
  readonly errorCode: RecommendErrorCode
  readonly durationMs: number
}

export type CandidateRecommendation =
  | UnevaluatedRecommendation
  | EvaluatedRecommendation
  | LowConfidenceRecommendation
  | InsufficientRecommendation
  | SkippedRecommendation
  | FailedRecommendation

export type CandidateRecommendPublic = {
  readonly status: RecommendStatus
  readonly grade: RecommendGrade | null
  readonly reasons: readonly RecommendReasonId[]
  readonly evaluatedAt: string | null
}

export type RecommendArticleInput = {
  readonly title: string
  readonly outlet: string
  readonly canonicalUrl: string
  readonly excerpt: string
}

export type EvaluateDeRecommendation = (
  input: RecommendArticleInput,
  deps: JevDeps,
  evaluate?: EvaluateSystemOne,
) => Promise<CandidateRecommendation>
