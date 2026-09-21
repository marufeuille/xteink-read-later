import { extractArticle } from '../extract/extract-article'
import { openRouterApiKey } from '../jev/client'
import { logCandidateRecommend } from '../log'
import { evaluateDeRecommendation, excerptFromExtractedHtml, excerptHashOf } from '../recommend/evaluate'
import {
  RECOMMEND_MAX_CALLS_PER_EVALUATION,
  insufficientRecommendation,
  isJudgedRecommendation,
  shouldReuseRecommendation,
} from '../recommend/taxonomy'
import {
  err,
  ok,
  type CandidateArticle,
  type CandidateRecommendation,
  type CandidateStore,
  type EvaluateSystemOne,
  type FetchPage,
  type JevDeps,
  type NotFoundError,
  type Result,
} from '../types'
import { assertFetchableCandidateUrl } from './fetch-policy'
import { extractCandidateMetadata } from './metadata'

export type RecommendBudget = {
  remainingCalls: number
}

export type ResolveRecommendInput = {
  readonly existing: CandidateRecommendation
  readonly extractedHtml: string | null
  readonly title: string
  readonly outlet: string
  readonly canonicalUrl: CandidateArticle['canonicalUrl']
  readonly paywalled: boolean
  readonly now: Date
  readonly force?: boolean
  readonly budget: RecommendBudget
  readonly jevDeps?: JevDeps
  readonly evaluate?: EvaluateSystemOne
}

export type ResolveRecommendResult = {
  readonly recommendation: CandidateRecommendation
  readonly reused: boolean
}

function reusedOf(recommendation: CandidateRecommendation): ResolveRecommendResult {
  return { recommendation, reused: true }
}

function freshOf(recommendation: CandidateRecommendation): ResolveRecommendResult {
  return { recommendation, reused: false }
}

export function logResolvedRecommendation(candidate: CandidateArticle, reused: boolean): void {
  const { recommendation } = candidate
  logCandidateRecommend({
    candidateId: candidate.id,
    status: recommendation.status,
    grade: recommendation.grade,
    version: recommendation.version,
    durationMs: recommendation.durationMs,
    inputTokens: recommendation.inputTokens,
    reused,
    errorCode: recommendation.errorCode,
  })
}

export async function resolveDeRecommendation(input: ResolveRecommendInput): Promise<ResolveRecommendResult> {
  if (input.paywalled) {
    return reusedOf(input.existing)
  }

  const evaluatedAt = input.now.toISOString()
  const excerpt =
    input.extractedHtml === null || input.extractedHtml.trim().length === 0
      ? ''
      : excerptFromExtractedHtml(input.extractedHtml, input.canonicalUrl)
  const excerptHash = excerpt.length > 0 ? await excerptHashOf(excerpt) : null
  const hasApiKey = input.jevDeps !== undefined && openRouterApiKey(input.jevDeps) !== null
  const force = input.force === true
  const reuseInput = { excerptHash, hasApiKey, force }

  if (excerptHash === null) {
    if (isJudgedRecommendation(input.existing)) {
      return reusedOf(input.existing)
    }
    return shouldReuseRecommendation(input.existing, { ...reuseInput, force: false })
      ? reusedOf(input.existing)
      : freshOf(insufficientRecommendation({ excerptHash: null, evaluatedAt }))
  }

  if (shouldReuseRecommendation(input.existing, reuseInput)) {
    return reusedOf(input.existing)
  }

  if (input.budget.remainingCalls < RECOMMEND_MAX_CALLS_PER_EVALUATION || input.jevDeps === undefined) {
    return {
      recommendation: input.existing,
      reused: input.existing.status !== 'unevaluated',
    }
  }

  input.budget.remainingCalls -= RECOMMEND_MAX_CALLS_PER_EVALUATION
  const recommendation = await evaluateDeRecommendation(
    {
      title: input.title,
      outlet: input.outlet,
      canonicalUrl: input.canonicalUrl,
      excerpt,
    },
    input.jevDeps,
    input.evaluate,
  )
  return freshOf(
    recommendation.status === 'unevaluated' ? recommendation : { ...recommendation, evaluatedAt },
  )
}

export type ReevaluateCandidateInput = {
  readonly candidateId: CandidateArticle['id']
  readonly force: boolean
  readonly store: CandidateStore
  readonly fetchPage: FetchPage
  readonly now: () => Date
  readonly jevDeps: JevDeps
  readonly evaluate?: EvaluateSystemOne
}

export async function reevaluateCandidate(
  input: ReevaluateCandidateInput,
): Promise<Result<{ candidate: CandidateArticle; reused: boolean }, NotFoundError>> {
  const existing = await input.store.getById(input.candidateId)
  if (existing === null) {
    return err({ kind: 'not_found' })
  }
  const now = input.now()
  const fetchable = assertFetchableCandidateUrl(existing.canonicalUrl)
  if (!fetchable.ok) {
    const recommendation = isJudgedRecommendation(existing.recommendation)
      ? existing.recommendation
      : insufficientRecommendation({
          excerptHash: existing.recommendation.excerptHash,
          evaluatedAt: now.toISOString(),
        })
    const updated = {
      ...existing,
      recommendation,
      updatedAt: now.toISOString(),
    }
    await input.store.put(updated)
    return ok({
      candidate: updated,
      reused: isJudgedRecommendation(existing.recommendation),
    })
  }

  const page = await input.fetchPage(existing.canonicalUrl)
  const metadata = page.ok ? extractCandidateMetadata(page.value) : null
  const extracted =
    page.ok && metadata !== null && !metadata.paywalled ? await extractArticle(page.value) : null
  const resolved = await resolveDeRecommendation({
    existing: existing.recommendation,
    extractedHtml: extracted?.ok === true ? extracted.value.contentHtml : null,
    title: metadata?.title ?? existing.title,
    outlet: metadata?.outlet ?? existing.outlet,
    canonicalUrl: metadata?.canonicalUrl ?? existing.canonicalUrl,
    paywalled: metadata?.paywalled === true || existing.exclusionReason === 'paywalled',
    now,
    force: input.force,
    budget: { remainingCalls: RECOMMEND_MAX_CALLS_PER_EVALUATION },
    jevDeps: input.jevDeps,
    ...(input.evaluate === undefined ? {} : { evaluate: input.evaluate }),
  })
  const updated: CandidateArticle = {
    ...existing,
    recommendation: resolved.recommendation,
    updatedAt: now.toISOString(),
  }
  await input.store.put(updated)
  logResolvedRecommendation(updated, resolved.reused)
  return ok({ candidate: updated, reused: resolved.reused })
}
