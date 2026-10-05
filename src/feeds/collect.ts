import {
  registerCandidate,
  type RegisteredCandidateMaterial,
} from '../candidates/register'
import {
  logResolvedRecommendation,
  resolveDeRecommendation,
  type ResolveRecommendResult,
} from '../candidates/recommend'
import {
  RECOMMEND_MAX_CALLS_PER_EVALUATION,
  RECOMMEND_MAX_CALLS_PER_FEED_ITEM,
  failedRecommendation,
} from '../recommend/taxonomy'
import {
  candidateFeedSourceKind,
  COLLECT_TIME_BUDGET_MS,
  MAX_FEED_ITEMS,
  type CandidateArticle,
  type CandidateStore,
  type EvaluateSystemOne,
  type FeedCollectionResult,
  type FeedRunId,
  type FeedSource,
  type FetchFeed,
  type FetchPage,
  type JevDeps,
} from '../types'
import { runFeedStage } from './failure-point'
import { parseFeed } from './parse'

export type CollectFeedDeps = {
  readonly candidateStore: CandidateStore
  readonly fetchFeed: FetchFeed
  readonly fetchPage: FetchPage
  readonly parseFeed?: typeof parseFeed
  readonly now?: () => Date
  readonly maxItems?: number
  readonly timeBudgetMs?: number
  readonly deadlineMs?: number
  readonly jevDeps?: JevDeps
  readonly evaluateRecommend?: EvaluateSystemOne
}

export async function collectFeed(
  source: FeedSource,
  runId: FeedRunId,
  deps: CollectFeedDeps,
): Promise<FeedCollectionResult> {
  if (!source.enabled) {
    return {
      sourceId: source.id,
      runId,
      status: 'ready',
      error: null,
      itemsSeen: 0,
      itemsRegistered: 0,
      itemsDuplicate: 0,
      itemsSkipped: 0,
    }
  }

  const now = deps.now ?? (() => new Date())
  const parse = deps.parseFeed ?? parseFeed
  const fetched = await runFeedStage('fetch', () => deps.fetchFeed(source.feedUrl))
  if (!fetched.ok) {
    return {
      sourceId: source.id,
      runId,
      status: 'failed',
      error: fetched.error,
      itemsSeen: 0,
      itemsRegistered: 0,
      itemsDuplicate: 0,
      itemsSkipped: 0,
    }
  }

  const parsed = await runFeedStage('parse', () => parse(fetched.value.xml, fetched.value.finalUrl))
  if (!parsed.ok) {
    return {
      sourceId: source.id,
      runId,
      status: 'failed',
      error: parsed.error,
      itemsSeen: 0,
      itemsRegistered: 0,
      itemsDuplicate: 0,
      itemsSkipped: 0,
    }
  }

  const maxItems = deps.maxItems ?? MAX_FEED_ITEMS
  const deadline = deps.deadlineMs ?? Date.now() + (deps.timeBudgetMs ?? COLLECT_TIME_BUDGET_MS)
  const sourceKind = candidateFeedSourceKind(source.id)
  const pending: RegisteredCandidateMaterial[] = []
  let itemsRegistered = 0
  let itemsDuplicate = 0
  let itemsSkipped = 0
  let processed = 0

  for (const item of parsed.value.items) {
    if (processed >= maxItems || Date.now() >= deadline) {
      itemsSkipped += parsed.value.items.length - processed
      break
    }
    processed += 1
    const registered = await runFeedStage('store', () =>
      registerCandidate(item.url, {
        store: deps.candidateStore,
        fetchPage: deps.fetchPage,
        now,
        sourceKind,
        // Keep Jev out of this loop. The deadline above is page-fetch time only.
        maxJevCalls: RECOMMEND_MAX_CALLS_PER_FEED_ITEM,
        deferRecommendation: true,
        onRegistered: (material) => {
          pending.push(material)
        },
      }),
    )
    if (!registered.ok) {
      itemsSkipped += 1
      continue
    }
    if (registered.value.duplicate) {
      itemsDuplicate += 1
    } else {
      itemsRegistered += 1
    }
  }

  // Judgment is a separate step. A slow Jev call must not skip later items.
  for (const material of pending) {
    await runFeedStage('store', () => judgeCollectedCandidate(material, deps))
  }

  return {
    sourceId: source.id,
    runId,
    status: 'ready',
    error: null,
    itemsSeen: parsed.value.items.length,
    itemsRegistered,
    itemsDuplicate,
    itemsSkipped,
  }
}

function hasExtractedBody(extractedHtml: string | null): boolean {
  return extractedHtml !== null && extractedHtml.trim().length > 0
}

async function judgeCollectedCandidate(
  material: RegisteredCandidateMaterial,
  deps: CollectFeedDeps,
): Promise<void> {
  const current = await deps.candidateStore.getById(material.candidate.id)
  if (current === null) {
    return
  }
  const now = (deps.now ?? (() => new Date()))()
  let resolved: ResolveRecommendResult
  try {
    resolved = await resolveDeRecommendation({
      existing: current.recommendation,
      extractedHtml: material.extractedHtml,
      title: current.title,
      outlet: current.outlet,
      canonicalUrl: current.canonicalUrl,
      paywalled: material.paywalled,
      now,
      budget: { remainingCalls: RECOMMEND_MAX_CALLS_PER_EVALUATION },
      ...(deps.jevDeps === undefined ? {} : { jevDeps: deps.jevDeps }),
      ...(deps.evaluateRecommend === undefined ? {} : { evaluate: deps.evaluateRecommend }),
    })
  } catch {
    // One thrown judgment must not drop the candidate or fail the collection.
    // Failed stays retryable on a later collection. This pass does not call again.
    if (material.paywalled || !hasExtractedBody(material.extractedHtml)) {
      return
    }
    resolved = {
      recommendation: failedRecommendation({
        excerptHash: current.recommendation.excerptHash,
        evaluatedAt: now.toISOString(),
        errorCode: 'recommend_internal',
      }),
      reused: false,
      budgetSkippedUnevaluated: false,
    }
  }
  if (resolved.budgetSkippedUnevaluated) {
    return
  }
  const updated: CandidateArticle = {
    ...current,
    recommendation: resolved.recommendation,
    updatedAt: now.toISOString(),
  }
  await deps.candidateStore.put(updated)
  logResolvedRecommendation(updated, resolved)
}
