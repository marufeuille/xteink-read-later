import type { PrRiskRuleVersion } from '../types'

export const PR_RISK_RULE_VERSION: PrRiskRuleVersion = 'pr-risk-v1'
export const PR_RISK_CONFIDENCE_MIN = 0.85
export const PR_RISK_NOUL_HIGH_MIN = 0.4
export const PR_RISK_MAX_DIFF_CHARS = 24_000
export const PR_RISK_MAX_BODY_CHARS = 4_000
export const PR_RISK_MAX_LINEAR_CHARS = 4_000
export const PR_RISK_MAX_FILES = 200
export const PR_RISK_COMMENT_MARKER = '<!-- pr-risk-judgment'
export const PR_RISK_JUDGMENT_FILENAME = 'pr-risk-judgment.json'
