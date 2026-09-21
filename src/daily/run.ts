import { reevaluateCandidate } from '../candidates/recommend'
import { logDailyDigest } from '../log'
import { createD1CandidateStore } from '../store/d1-candidates'
import { createD1DigestStore } from '../store/d1-digest'
import { createR2Store } from '../store/r2'
import {
  DIGEST_LIST_PAGE_SIZE,
  DIGEST_MAX_JEV_CALLS,
  type ArticleStore,
  type CandidateArticle,
  type CandidateStore,
  type CreateArticleStore,
  type CreateCandidateStore,
  type CreateDigestStore,
  type DigestPreparedItem,
  type DigestPublishedItem,
  type DigestRunResult,
  type DigestStore,
  type EvaluateSystemOne,
  type FetchPage,
  type JevDeps,
} from '../types'
import { dailyDateFromInstant } from './identity'
import { buildDailyDigestWrite } from './issue'
import { publishLatestDaily, unpublishDailyDigests } from './publish'
import { countDigestBuckets, digestNeedsEvaluation, digestQuotasFilled, selectDigestCandidates } from './select'
import { summarizeDigestArticle, type SummarizeDigestArticle } from './summarize'

export type RunDailyDigestDeps = {
  readonly date?: string
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly candidateStore?: CandidateStore
  readonly createCandidateStore?: CreateCandidateStore
  readonly digestStore?: DigestStore
  readonly createDigestStore?: CreateDigestStore
  readonly fetchPage: FetchPage
  readonly summarize?: SummarizeDigestArticle
  readonly evaluateRecommend?: EvaluateSystemOne
  readonly now?: () => Date
  readonly maxJevCalls?: number
}

function storeFor(env: Cloudflare.Env, deps: RunDailyDigestDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  const create = deps.createStore ?? createR2Store
  return create(env)
}

function candidateStoreFor(env: Cloudflare.Env, deps: RunDailyDigestDeps): CandidateStore {
  if (deps.candidateStore !== undefined) {
    return deps.candidateStore
  }
  const create = deps.createCandidateStore ?? createD1CandidateStore
  return create(env)
}

function digestStoreFor(env: Cloudflare.Env, deps: RunDailyDigestDeps): DigestStore {
  if (deps.digestStore !== undefined) {
    return deps.digestStore
  }
  const create = deps.createDigestStore ?? createD1DigestStore
  return create(env)
}

async function listAllListed(store: CandidateStore): Promise<CandidateArticle[]> {
  const items: CandidateArticle[] = []
  let offset = 0
  for (;;) {
    const page = await store.listListed({ limit: DIGEST_LIST_PAGE_SIZE, offset })
    items.push(...page.items)
    offset += page.items.length
    if (page.items.length === 0 || offset >= page.total) {
      break
    }
  }
  return items
}

async function evaluateNeeded(
  candidates: readonly CandidateArticle[],
  usedCanonicalUrls: ReadonlySet<string>,
  deps: {
    readonly store: CandidateStore
    readonly fetchPage: FetchPage
    readonly now: () => Date
    readonly jevDeps: JevDeps
    readonly evaluate?: EvaluateSystemOne
    readonly maxJevCalls: number
  },
): Promise<CandidateArticle[]> {
  const pool = candidates.filter((candidate) => !usedCanonicalUrls.has(candidate.canonicalUrl))
  const byId = new Map(pool.map((candidate) => [candidate.id, candidate]))
  const pending = pool
    .filter(digestNeedsEvaluation)
    .sort((left, right) => (left.discoveredAt < right.discoveredAt ? 1 : -1))
  let remaining = deps.maxJevCalls

  for (const candidate of pending) {
    if (remaining < 1 || digestQuotasFilled(countDigestBuckets(byId.values()))) {
      break
    }
    remaining -= 1
    try {
      const result = await reevaluateCandidate({
        candidateId: candidate.id,
        force: false,
        store: deps.store,
        fetchPage: deps.fetchPage,
        now: deps.now,
        jevDeps: deps.jevDeps,
        ...(deps.evaluate === undefined ? {} : { evaluate: deps.evaluate }),
      })
      if (result.ok) {
        byId.set(result.value.candidate.id, result.value.candidate)
      }
    } catch {
      continue
    }
  }

  return [...byId.values()]
}

async function summarizeSelected(
  selected: readonly CandidateArticle[],
  env: Cloudflare.Env,
  fetchPage: FetchPage,
  summarize: SummarizeDigestArticle,
): Promise<{ prepared: DigestPreparedItem[]; skipped: number }> {
  const prepared: DigestPreparedItem[] = []
  let skipped = 0
  for (const candidate of selected) {
    try {
      const summarized = await summarize(candidate, {
        OPENAI_API_KEY: env.OPENAI_API_KEY,
        fetchPage,
      })
      if (summarized.ok) {
        prepared.push(summarized.value)
      } else {
        skipped += 1
      }
    } catch {
      skipped += 1
    }
  }
  return { prepared, skipped }
}

function publishedHistory(date: string, items: readonly DigestPreparedItem[]): DigestPublishedItem[] {
  return items.map((item) => ({
    date,
    candidateId: item.candidateId,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
  }))
}

function emptyResult(date: string, status: DigestRunResult['status'], selected = 0, skipped = 0): DigestRunResult {
  return { date, status, selected, summarized: 0, skipped, articleId: null }
}

export async function runDailyDigest(env: Cloudflare.Env, deps: RunDailyDigestDeps): Promise<DigestRunResult> {
  const started = Date.now()
  const now = deps.now ?? (() => new Date())
  const date = deps.date ?? dailyDateFromInstant(now())
  const store = storeFor(env, deps)
  const candidateStore = candidateStoreFor(env, deps)
  const digestStore = digestStoreFor(env, deps)
  const summarize = deps.summarize ?? summarizeDigestArticle
  const finish = (result: DigestRunResult): DigestRunResult => {
    logDigestRun(result, Date.now() - started)
    return result
  }

  try {
    const usedCanonicalUrls = await digestStore.listPublishedCanonicalUrlsExcept(date)
    const evaluated = await evaluateNeeded(await listAllListed(candidateStore), usedCanonicalUrls, {
      store: candidateStore,
      fetchPage: deps.fetchPage,
      now,
      jevDeps: { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY },
      maxJevCalls: deps.maxJevCalls ?? DIGEST_MAX_JEV_CALLS,
      ...(deps.evaluateRecommend === undefined ? {} : { evaluate: deps.evaluateRecommend }),
    })
    const selected = selectDigestCandidates(evaluated, { usedCanonicalUrls })
    const { prepared, skipped } = await summarizeSelected(selected, env, deps.fetchPage, summarize)

    if (prepared.length === 0) {
      await unpublishDailyDigests(store)
      return finish(emptyResult(date, 'empty', selected.length, skipped))
    }

    const built = await buildDailyDigestWrite({ date, items: prepared })
    const published = await publishLatestDaily(store, built.write)
    await digestStore.replacePublishedItems(date, publishedHistory(date, prepared))
    return finish({
      date,
      status: 'published',
      selected: selected.length,
      summarized: prepared.length,
      skipped,
      articleId: published.meta.id,
    })
  } catch {
    await unpublishDailyDigests(store)
    return finish(emptyResult(date, 'failed'))
  }
}

function logDigestRun(result: DigestRunResult, durationMs: number): void {
  logDailyDigest({
    date: result.date,
    status: result.status,
    selected: result.selected,
    summarized: result.summarized,
    skipped: result.skipped,
    durationMs,
    ...(result.articleId === null ? {} : { articleId: result.articleId }),
  })
}
