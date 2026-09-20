import { evaluateSystemOne as defaultEvaluateSystemOne, openRouterApiKey } from '../jev/client'
import type {
  ChoiceAnswer,
  ClassifyPrRisk,
  PrRiskBlocker,
  PrRiskChangeChoice,
  PrRiskJevAnswers,
  PrRiskJevResult,
  PrRiskJudgment,
  SystemOneAnswer,
  SystemOneResult,
} from '../types'
import { PR_RISK_CONFIDENCE_MIN, PR_RISK_NOUL_HIGH_MIN, PR_RISK_RULE_VERSION } from './constants'
import { matchHardRules } from './hard-rules'
import { buildUntrustedState, summarizeInput } from './input'
import { PR_RISK_QUESTIONS } from './questions'

function choiceAnswer(
  answers: Readonly<Record<string, SystemOneAnswer>>,
  key: 'change_risk',
): ChoiceAnswer | null {
  const answer = answers[key]
  return answer?.type === 'choice' ? answer : null
}

function noulValue(
  answers: Readonly<Record<string, SystemOneAnswer>>,
  key: 'touches_auth' | 'touches_secrets' | 'touches_data_lifecycle' | 'touches_ci_deploy_rules',
): number | null {
  const answer = answers[key]
  return answer?.type === 'noul' ? answer.noul : null
}

function parseJevAnswers(answers: Readonly<Record<string, SystemOneAnswer>>): PrRiskJevAnswers | null {
  const changeRisk = choiceAnswer(answers, 'change_risk')
  const touchesAuth = noulValue(answers, 'touches_auth')
  const touchesSecrets = noulValue(answers, 'touches_secrets')
  const touchesDataLifecycle = noulValue(answers, 'touches_data_lifecycle')
  const touchesCiDeployRules = noulValue(answers, 'touches_ci_deploy_rules')
  if (
    changeRisk === null ||
    touchesAuth === null ||
    touchesSecrets === null ||
    touchesDataLifecycle === null ||
    touchesCiDeployRules === null
  ) {
    return null
  }
  return {
    changeRisk: {
      choice: changeRisk.choice,
      confidence: changeRisk.confidence,
      probabilities: changeRisk.probabilities,
    },
    touchesAuth,
    touchesSecrets,
    touchesDataLifecycle,
    touchesCiDeployRules,
  }
}

function isChangeChoice(value: string): value is PrRiskChangeChoice {
  return value === 'low' || value === 'high'
}

function noulHigh(answers: PrRiskJevAnswers): boolean {
  return (
    Math.max(
      answers.touchesAuth,
      answers.touchesSecrets,
      answers.touchesDataLifecycle,
      answers.touchesCiDeployRules,
    ) >= PR_RISK_NOUL_HIGH_MIN
  )
}

function jevBlockers(parsed: PrRiskJevAnswers): readonly PrRiskBlocker[] {
  const blockers: PrRiskBlocker[] = []
  if (!isChangeChoice(parsed.changeRisk.choice)) {
    blockers.push('jev_failed')
  } else if (parsed.changeRisk.confidence < PR_RISK_CONFIDENCE_MIN) {
    blockers.push('low_confidence')
  } else if (parsed.changeRisk.choice === 'high') {
    blockers.push('jev_high')
  }
  if (noulHigh(parsed)) {
    blockers.push('noul_high')
  }
  return blockers
}

function jevResult(result: SystemOneResult, durationMs: number, answers: PrRiskJevAnswers): PrRiskJevResult {
  return {
    ...answers,
    model: result.model,
    durationMs,
    inputTokens: result.usage.inputTokens,
  }
}

function inputBlockers(
  input: PrRiskJudgment['input'],
  hardRules: PrRiskJudgment['hardRules'],
): readonly PrRiskBlocker[] {
  const blockers: PrRiskBlocker[] = []
  if (input.missingDiff || input.truncated) {
    blockers.push('incomplete_input')
  }
  if (hardRules.matched) {
    blockers.push('hard_rule')
  }
  return blockers
}

function judgment(
  base: Omit<PrRiskJudgment, 'jev' | 'jevError' | 'recommendedRoute' | 'blockers'>,
  blockers: readonly PrRiskBlocker[],
  jev: PrRiskJudgment['jev'],
  jevError: PrRiskJudgment['jevError'],
): PrRiskJudgment {
  return {
    ...base,
    jev,
    jevError,
    recommendedRoute: blockers.length === 0 ? 'low_risk' : 'additional_review',
    blockers,
  }
}

export const classifyPrRisk: ClassifyPrRisk = async (
  request,
  deps,
  evaluate = defaultEvaluateSystemOne,
) => {
  const input = summarizeInput(request)
  const hardRules = matchHardRules(request.files)
  const blockers = inputBlockers(input, hardRules)
  const base = {
    trialAction: 'record_only' as const,
    ruleVersion: PR_RISK_RULE_VERSION,
    headSha: request.headSha,
    baseSha: request.baseSha,
    prNumber: request.prNumber,
    recordedAt: request.recordedAt,
    input,
    hardRules,
  }

  if (openRouterApiKey(deps) === null) {
    return judgment(base, [...blockers, 'jev_skipped'], null, null)
  }

  const { state } = buildUntrustedState(request)
  const started = Date.now()
  const result = await evaluate({ state, questions: PR_RISK_QUESTIONS }, deps)
  const durationMs = Date.now() - started
  if (!result.ok) {
    return judgment(base, [...blockers, 'jev_failed'], null, {
      code: result.error.code,
      reason: result.error.reason,
    })
  }

  const parsed = parseJevAnswers(result.value.answers)
  if (parsed === null) {
    return judgment(base, [...blockers, 'jev_failed'], null, {
      code: 'invalid_payload',
      reason: 'Jev answers were missing or had the wrong types',
    })
  }

  return judgment(
    base,
    [...blockers, ...jevBlockers(parsed)],
    jevResult(result.value, durationMs, parsed),
    null,
  )
}
