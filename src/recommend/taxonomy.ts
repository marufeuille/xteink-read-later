import {
  RECOMMEND_ERROR_CODES,
  RECOMMEND_GRADES,
  RECOMMEND_STATUSES,
  type CandidateRecommendPublic,
  type CandidateRecommendation,
  type EvaluatedRecommendation,
  type FailedRecommendation,
  type InsufficientRecommendation,
  type LowConfidenceRecommendation,
  type RecommendErrorCode,
  type RecommendGrade,
  type RecommendReasonId,
  type RecommendStatus,
  type RecommendVersion,
  type SkippedRecommendation,
  type UnevaluatedRecommendation,
} from '../types'

export const RECOMMEND_VERSION: RecommendVersion = 'de-recommend-v1'
export const RECOMMEND_MIN_CONFIDENCE = 0.7
export const RECOMMEND_NOUL_TRUE_MIN = 0.5
export const RECOMMEND_MAX_EXCERPT_CHARS = 6_000
export const RECOMMEND_MAX_HTML_CHARS = 16_000
export const RECOMMEND_MAX_CALLS_PER_EVALUATION = 1
export const RECOMMEND_MAX_CALLS_PER_REGISTER = 1
export const RECOMMEND_MAX_CALLS_PER_FEED_ITEM = 0

export const RECOMMEND_GRADE_CRITERIA: Readonly<Record<RecommendGrade, string>> = {
  recommended:
    'データエンジニアの仕事（データ基盤、パイプライン、ウェアハウス、品質、オーケストレーション、分析基盤、運用）に直結し、設計・実装・運用の具体がある。LLM/AI の話でも、データの流れ・品質・基盤・運用との関係がはっきりしている。',
  related:
    'データエンジニアの仕事と接点はあるが、周辺技術・概論・製品発表・ニュース寄りで、すぐ実務に使う手がかりは少ない。',
  low_priority:
    'データエンジニアの仕事との関係が薄い。一般ニュース、経済、純粋なアプリ UI、基盤と無関係な話題。速報や発表だけで実務の手がかりが無いものも含む。',
}

export const RECOMMEND_GRADE_LABELS: Readonly<Record<RecommendGrade, string>> = {
  recommended: 'データエンジニアにおすすめ',
  related: '関連あり',
  low_priority: '優先度低',
}

export const RECOMMEND_STATUS_LABELS: Readonly<Record<RecommendStatus, string>> = {
  unevaluated: '未判定',
  evaluated: '判定済み',
  low_confidence: '低確信',
  insufficient_material: '材料不足',
  skipped: '未判定（キーなし）',
  failed: '判定失敗',
}

export const RECOMMEND_REASON_LABELS: Readonly<Record<RecommendReasonId, string>> = {
  de_relevant: 'DE関連',
  has_concreteness: '設計・実装・運用の具体',
  has_verification: '検証・制約',
}

const GRADE_SET = new Set<string>(RECOMMEND_GRADES)
const STATUS_SET = new Set<string>(RECOMMEND_STATUSES)
const ERROR_SET = new Set<string>(RECOMMEND_ERROR_CODES)

export function isRecommendGrade(value: string): value is RecommendGrade {
  return GRADE_SET.has(value)
}

export function isRecommendStatus(value: string): value is RecommendStatus {
  return STATUS_SET.has(value)
}

export function isRecommendErrorCode(value: string): value is RecommendErrorCode {
  return ERROR_SET.has(value)
}

export function isRecommendVersion(value: string): value is RecommendVersion {
  return value === RECOMMEND_VERSION
}

function durationMsOf(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
}

const UNAVAILABLE_AXES = {
  grade: null,
  decidedGrade: null,
  confidence: null,
  model: null,
  relevant: null,
  concrete: null,
  verification: null,
  inputTokens: null,
} as const

export function unevaluatedRecommendation(): UnevaluatedRecommendation {
  return {
    status: 'unevaluated',
    version: null,
    excerptHash: null,
    evaluatedAt: null,
    errorCode: null,
    durationMs: 0,
    ...UNAVAILABLE_AXES,
  }
}

export function insufficientRecommendation(input: {
  readonly excerptHash: string | null
  readonly evaluatedAt: string
  readonly durationMs?: number
  readonly version?: RecommendVersion
}): InsufficientRecommendation {
  return {
    status: 'insufficient_material',
    version: input.version ?? RECOMMEND_VERSION,
    excerptHash: input.excerptHash,
    evaluatedAt: input.evaluatedAt,
    errorCode: null,
    durationMs: durationMsOf(input.durationMs ?? 0),
    ...UNAVAILABLE_AXES,
  }
}

export function skippedRecommendation(input: {
  readonly excerptHash: string
  readonly evaluatedAt: string
  readonly version?: RecommendVersion
}): SkippedRecommendation {
  return {
    status: 'skipped',
    version: input.version ?? RECOMMEND_VERSION,
    excerptHash: input.excerptHash,
    evaluatedAt: input.evaluatedAt,
    errorCode: null,
    durationMs: 0,
    ...UNAVAILABLE_AXES,
  }
}

export function failedRecommendation(input: {
  readonly excerptHash: string | null
  readonly evaluatedAt: string
  readonly errorCode: RecommendErrorCode
  readonly durationMs?: number
  readonly version?: RecommendVersion
}): FailedRecommendation {
  return {
    status: 'failed',
    version: input.version ?? RECOMMEND_VERSION,
    excerptHash: input.excerptHash,
    evaluatedAt: input.evaluatedAt,
    errorCode: input.errorCode,
    durationMs: durationMsOf(input.durationMs ?? 0),
    ...UNAVAILABLE_AXES,
  }
}

type EvaluatedInput = Pick<
  EvaluatedRecommendation,
  | 'grade'
  | 'confidence'
  | 'model'
  | 'excerptHash'
  | 'evaluatedAt'
  | 'relevant'
  | 'concrete'
  | 'verification'
  | 'inputTokens'
  | 'durationMs'
> & {
  readonly version?: RecommendVersion
}

export function evaluatedRecommendation(input: EvaluatedInput): EvaluatedRecommendation {
  return {
    ...input,
    status: 'evaluated',
    version: input.version ?? RECOMMEND_VERSION,
    decidedGrade: input.grade,
    errorCode: null,
    durationMs: durationMsOf(input.durationMs),
  }
}

type LowConfidenceInput = Pick<
  LowConfidenceRecommendation,
  | 'decidedGrade'
  | 'confidence'
  | 'model'
  | 'excerptHash'
  | 'evaluatedAt'
  | 'relevant'
  | 'concrete'
  | 'verification'
  | 'inputTokens'
  | 'durationMs'
> & {
  readonly version?: RecommendVersion
}

export function lowConfidenceRecommendation(input: LowConfidenceInput): LowConfidenceRecommendation {
  return {
    ...input,
    status: 'low_confidence',
    version: input.version ?? RECOMMEND_VERSION,
    grade: null,
    errorCode: null,
    durationMs: durationMsOf(input.durationMs),
  }
}

export function isJudgedRecommendation(recommendation: CandidateRecommendation): boolean {
  return recommendation.status === 'evaluated' || recommendation.status === 'low_confidence'
}

export function noulIsTrue(value: number | null): boolean | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }
  return value >= RECOMMEND_NOUL_TRUE_MIN
}

export function shouldReuseRecommendation(
  existing: CandidateRecommendation,
  input: {
    readonly excerptHash: string | null
    readonly hasApiKey: boolean
    readonly force: boolean
  },
): boolean {
  if (input.force || existing.status === 'unevaluated' || existing.status === 'failed') {
    return false
  }
  if (existing.version !== RECOMMEND_VERSION) {
    return false
  }
  if (existing.status === 'skipped') {
    return !input.hasApiKey && existing.excerptHash === input.excerptHash
  }
  if (existing.status === 'insufficient_material') {
    return existing.excerptHash === input.excerptHash
  }
  return existing.excerptHash !== null && existing.excerptHash === input.excerptHash
}

export function recommendReasons(recommendation: CandidateRecommendation): readonly RecommendReasonId[] {
  if (recommendation.status !== 'evaluated') {
    return []
  }
  const reasons: RecommendReasonId[] = []
  if (recommendation.relevant) {
    reasons.push('de_relevant')
  }
  if (recommendation.concrete) {
    reasons.push('has_concreteness')
  }
  if (recommendation.verification) {
    reasons.push('has_verification')
  }
  return reasons
}

export function toRecommendPublic(recommendation: CandidateRecommendation): CandidateRecommendPublic {
  return {
    status: recommendation.status,
    grade: recommendation.grade,
    reasons: recommendReasons(recommendation),
    evaluatedAt: recommendation.evaluatedAt,
  }
}

export function recommendDisplayLabel(recommendation: CandidateRecommendPublic): string {
  if (recommendation.status === 'evaluated' && recommendation.grade !== null) {
    return RECOMMEND_GRADE_LABELS[recommendation.grade]
  }
  return RECOMMEND_STATUS_LABELS[recommendation.status]
}
