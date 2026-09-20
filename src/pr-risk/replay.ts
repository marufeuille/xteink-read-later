import type { PrRiskJudgment } from '../types/index.ts'

export function trialSummary(judgments: readonly PrRiskJudgment[]): {
  readonly total: number
  readonly additionalReview: number
  readonly lowRisk: number
  readonly hardRule: number
  readonly jevSkipped: number
  readonly hardRuleMisses: number
} {
  const count = (matches: (judgment: PrRiskJudgment) => boolean): number =>
    judgments.filter(matches).length
  return {
    total: judgments.length,
    additionalReview: count((judgment) => judgment.recommendedRoute === 'additional_review'),
    lowRisk: count((judgment) => judgment.recommendedRoute === 'low_risk'),
    hardRule: count((judgment) => judgment.hardRules.matched),
    jevSkipped: count((judgment) => judgment.blockers.includes('jev_skipped')),
    hardRuleMisses: count(
      (judgment) => judgment.hardRules.matched && judgment.recommendedRoute === 'low_risk',
    ),
  }
}
