import type { EvaluateSystemOne, JevDeps, JevErrorCode } from './jev'

export type PrRiskRuleVersion = 'pr-risk-v1'
export type PrRiskRoute = 'additional_review' | 'low_risk'
export type PrRiskTrialAction = 'record_only'
export type PrRiskChangeChoice = 'low' | 'high'

export type HardRuleReason =
  | 'auth'
  | 'secrets'
  | 'data_lifecycle'
  | 'ci_deploy'
  | 'judgment_rules'

export type PrRiskBlocker =
  | 'incomplete_input'
  | 'hard_rule'
  | 'jev_skipped'
  | 'jev_failed'
  | 'low_confidence'
  | 'jev_high'
  | 'noul_high'

export type PrChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown'

export type PrChangedFile = {
  readonly path: string
  readonly previousPath?: string
  readonly status: PrChangedFileStatus
  readonly additions: number | null
  readonly deletions: number | null
}

export type PrRiskClassifyRequest = {
  readonly headSha: string
  readonly baseSha: string
  readonly prNumber: number | null
  readonly title: string
  readonly body: string
  readonly files: readonly PrChangedFile[]
  readonly diff: string | null
  readonly linearIds: readonly string[]
  readonly linearAcceptance: string | null
  readonly recordedAt: string
  readonly filesIncomplete?: boolean
}

export type PrRiskInputSummary = {
  readonly files: readonly string[]
  readonly testFiles: readonly string[]
  readonly fileCount: number
  readonly diffChars: number
  readonly bodyChars: number
  readonly truncated: boolean
  readonly missingDiff: boolean
  readonly linearIds: readonly string[]
  readonly linearAcceptancePresent: boolean
}

export type PrRiskJevAnswers = {
  readonly changeRisk: {
    readonly choice: string
    readonly confidence: number
    readonly probabilities: Readonly<Record<string, number>>
  }
  readonly touchesAuth: number
  readonly touchesSecrets: number
  readonly touchesDataLifecycle: number
  readonly touchesCiDeployRules: number
}

export type PrRiskJevResult = PrRiskJevAnswers & {
  readonly model: string
  readonly durationMs: number
  readonly inputTokens: number | null
}

export type HardRuleMatch = {
  readonly matched: boolean
  readonly reasons: readonly HardRuleReason[]
  readonly files: readonly string[]
}

export type PrRiskJudgment = {
  readonly trialAction: PrRiskTrialAction
  readonly ruleVersion: PrRiskRuleVersion
  readonly headSha: string
  readonly baseSha: string
  readonly prNumber: number | null
  readonly recordedAt: string
  readonly input: PrRiskInputSummary
  readonly hardRules: HardRuleMatch
  readonly jev: PrRiskJevResult | null
  readonly jevError: { readonly code: JevErrorCode; readonly reason: string } | null
  readonly recommendedRoute: PrRiskRoute
  readonly blockers: readonly PrRiskBlocker[]
}

export type ClassifyPrRisk = (
  request: PrRiskClassifyRequest,
  deps: JevDeps,
  evaluate?: EvaluateSystemOne,
) => Promise<PrRiskJudgment>
