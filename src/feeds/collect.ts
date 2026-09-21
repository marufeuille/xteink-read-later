import { registerCandidate } from '../candidates/register'
import { RECOMMEND_MAX_CALLS_PER_FEED_ITEM } from '../recommend/taxonomy'
import {
  candidateFeedSourceKind,
  COLLECT_TIME_BUDGET_MS,
  MAX_FEED_ITEMS,
  type CandidateStore,
  type FeedCollectionResult,
  type FeedRunId,
  type FeedSource,
  type FetchFeed,
  type FetchPage,
} from '../types'
import { parseFeed } from './parse'

export type CollectFeedDeps = {
  readonly candidateStore: CandidateStore
  readonly fetchFeed: FetchFeed
  readonly fetchPage: FetchPage
  readonly now?: () => Date
  readonly maxItems?: number
  readonly timeBudgetMs?: number
  readonly deadlineMs?: number
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
  const fetched = await deps.fetchFeed(source.feedUrl)
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

  const parsed = parseFeed(fetched.value.xml, fetched.value.finalUrl)
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
    const registered = await registerCandidate(item.url, {
      store: deps.candidateStore,
      fetchPage: deps.fetchPage,
      now,
      sourceKind,
      maxJevCalls: RECOMMEND_MAX_CALLS_PER_FEED_ITEM,
    })
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
