import type { CandidateRecommendation, RecommendStatus } from '../types'
import {
  evaluatedRecommendation,
  failedRecommendation,
  insufficientRecommendation,
  isRecommendErrorCode,
  isRecommendGrade,
  isRecommendStatus,
  isRecommendVersion,
  lowConfidenceRecommendation,
  skippedRecommendation,
  unevaluatedRecommendation,
} from './taxonomy'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asLabel<T extends string>(value: unknown, isAllowed: (value: string) => value is T): T | null {
  return typeof value === 'string' && isAllowed(value) ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBool01(value: unknown): boolean | null {
  if (value === 1 || value === true) {
    return true
  }
  if (value === 0 || value === false) {
    return false
  }
  return null
}

function bool01(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0
}

export function parseCandidateRecommendation(row: unknown): CandidateRecommendation {
  if (!isRecord(row)) {
    return unevaluatedRecommendation()
  }
  const status = asLabel(row.recommend_status, isRecommendStatus)
  if (status === null || status === 'unevaluated') {
    return unevaluatedRecommendation()
  }
  const excerptHash = asNonEmptyString(row.recommend_excerpt_hash)
  const evaluatedAt = asNonEmptyString(row.recommend_evaluated_at)
  const version = asLabel(row.recommend_version, isRecommendVersion)
  const durationMs = asFinite(row.recommend_duration_ms) ?? 0
  if (status === 'insufficient_material') {
    return evaluatedAt === null || version === null
      ? unevaluatedRecommendation()
      : insufficientRecommendation({ excerptHash, evaluatedAt, durationMs, version })
  }
  if (status === 'skipped') {
    return excerptHash === null || evaluatedAt === null || version === null
      ? unevaluatedRecommendation()
      : skippedRecommendation({ excerptHash, evaluatedAt, version })
  }
  if (status === 'failed') {
    return evaluatedAt === null || version === null
      ? unevaluatedRecommendation()
      : failedRecommendation({
          excerptHash,
          evaluatedAt,
          errorCode: asLabel(row.recommend_error_code, isRecommendErrorCode) ?? 'recommend_internal',
          durationMs,
          version,
        })
  }
  if (excerptHash === null || evaluatedAt === null || version === null) {
    return unevaluatedRecommendation()
  }
  const decidedGrade = asLabel(row.recommend_decided_grade, isRecommendGrade)
  const grade = asLabel(row.recommend_grade, isRecommendGrade)
  const model = asNonEmptyString(row.recommend_model)
  const confidence = asFinite(row.recommend_confidence)
  const relevant = asBool01(row.recommend_relevant)
  const concrete = asBool01(row.recommend_concrete)
  const verification = asBool01(row.recommend_verification)
  const inputTokens = asFinite(row.recommend_input_tokens)
  if (
    status === 'evaluated' &&
    grade !== null &&
    decidedGrade !== null &&
    confidence !== null &&
    model !== null &&
    relevant !== null &&
    concrete !== null &&
    verification !== null
  ) {
    return evaluatedRecommendation({
      grade,
      confidence,
      model,
      excerptHash,
      evaluatedAt,
      relevant,
      concrete,
      verification,
      inputTokens,
      durationMs,
      version,
    })
  }
  return lowConfidenceRecommendation({
    decidedGrade,
    confidence,
    model,
    excerptHash,
    evaluatedAt,
    relevant,
    concrete,
    verification,
    inputTokens,
    durationMs,
    version,
  })
}

export function recommendBindValues(recommendation: CandidateRecommendation): readonly [
  RecommendStatus,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number | null,
  number | null,
  number | null,
  number | null,
  string | null,
  number | null,
  number,
] {
  return [
    recommendation.status,
    recommendation.grade,
    recommendation.decidedGrade,
    recommendation.version,
    recommendation.model,
    recommendation.evaluatedAt,
    recommendation.excerptHash,
    recommendation.confidence,
    bool01(recommendation.relevant),
    bool01(recommendation.concrete),
    bool01(recommendation.verification),
    recommendation.errorCode,
    recommendation.inputTokens,
    recommendation.durationMs,
  ]
}
