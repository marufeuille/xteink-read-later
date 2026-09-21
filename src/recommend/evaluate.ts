import { htmlToMarkdown } from '../extract/sanitize-html'
import { evaluateSystemOne as defaultEvaluateSystemOne, openRouterApiKey } from '../jev/client'
import type {
  ChoiceAnswer,
  EvaluateDeRecommendation,
  HttpUrl,
  JevErrorCode,
  RecommendErrorCode,
  SystemOneAnswer,
} from '../types'
import { RECOMMEND_QUESTIONS } from './questions'
import {
  RECOMMEND_MAX_EXCERPT_CHARS,
  RECOMMEND_MAX_HTML_CHARS,
  RECOMMEND_MIN_CONFIDENCE,
  evaluatedRecommendation,
  failedRecommendation,
  isRecommendGrade,
  lowConfidenceRecommendation,
  noulIsTrue,
  skippedRecommendation,
} from './taxonomy'

const RECOMMEND_ERROR_BY_JEV: Record<JevErrorCode, RecommendErrorCode> = {
  http: 'recommend_http',
  timeout: 'recommend_timeout',
  invalid_payload: 'recommend_invalid_payload',
  missing_key: 'recommend_internal',
  network: 'recommend_internal',
}

function choiceAnswer(
  answers: Readonly<Record<string, SystemOneAnswer>>,
  key: 'recommendation',
): ChoiceAnswer | null {
  const answer = answers[key]
  return answer?.type === 'choice' ? answer : null
}

function noulValue(
  answers: Readonly<Record<string, SystemOneAnswer>>,
  key: 'de_relevant' | 'has_concreteness' | 'has_verification',
): number | null {
  const answer = answers[key]
  return answer?.type === 'noul' ? answer.noul : null
}

export function excerptFromExtractedHtml(contentHtml: string, canonicalUrl: HttpUrl): string {
  return htmlToMarkdown(contentHtml.slice(0, RECOMMEND_MAX_HTML_CHARS), canonicalUrl)
    .trim()
    .slice(0, RECOMMEND_MAX_EXCERPT_CHARS)
}

export async function excerptHashOf(excerpt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(excerpt))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export const evaluateDeRecommendation: EvaluateDeRecommendation = async (
  input,
  deps,
  evaluate = defaultEvaluateSystemOne,
) => {
  const excerptHash = await excerptHashOf(input.excerpt)
  const evaluatedAt = new Date().toISOString()
  if (openRouterApiKey(deps) === null) {
    return skippedRecommendation({ excerptHash, evaluatedAt })
  }

  const started = Date.now()
  const result = await evaluate(
    {
      state: {
        title: input.title,
        outlet: input.outlet,
        canonicalUrl: input.canonicalUrl,
        excerpt: input.excerpt,
      },
      questions: RECOMMEND_QUESTIONS,
    },
    deps,
  )
  const durationMs = Date.now() - started
  if (!result.ok) {
    return failedRecommendation({
      excerptHash,
      evaluatedAt,
      errorCode: RECOMMEND_ERROR_BY_JEV[result.error.code],
      durationMs,
    })
  }

  const gradeAnswer = choiceAnswer(result.value.answers, 'recommendation')
  const relevantNoul = noulValue(result.value.answers, 'de_relevant')
  const concreteNoul = noulValue(result.value.answers, 'has_concreteness')
  const verificationNoul = noulValue(result.value.answers, 'has_verification')
  if (gradeAnswer === null || relevantNoul === null || concreteNoul === null || verificationNoul === null) {
    return failedRecommendation({
      excerptHash,
      evaluatedAt,
      errorCode: 'recommend_invalid_payload',
      durationMs,
    })
  }

  const decidedGrade = isRecommendGrade(gradeAnswer.choice) ? gradeAnswer.choice : null
  const relevant = noulIsTrue(relevantNoul)
  const concrete = noulIsTrue(concreteNoul)
  const verification = noulIsTrue(verificationNoul)
  const confidence = Number.isFinite(gradeAnswer.confidence) ? gradeAnswer.confidence : null
  const model = result.value.model.length > 0 ? result.value.model : null
  if (
    decidedGrade !== null &&
    confidence !== null &&
    confidence >= RECOMMEND_MIN_CONFIDENCE &&
    relevant !== null &&
    concrete !== null &&
    verification !== null &&
    model !== null
  ) {
    return evaluatedRecommendation({
      grade: decidedGrade,
      confidence,
      model,
      excerptHash,
      evaluatedAt,
      relevant,
      concrete,
      verification,
      inputTokens: result.value.usage.inputTokens,
      durationMs,
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
    inputTokens: result.value.usage.inputTokens,
    durationMs,
  })
}
