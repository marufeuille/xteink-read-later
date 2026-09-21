import { extractArticle } from '../extract/extract-article'
import {
  CANDIDATE_SOURCE_KIND_MANUAL_URL,
  candidateDiscoveryIdFrom,
  candidateIdFromCanonicalUrl,
  ok,
  type CandidateArticle,
  type CandidateRegisterResult,
  type CandidateSourceKind,
  type CandidateStore,
  type EvaluateSystemOne,
  type FetchPage,
  type HttpUrl,
  type InvalidUrlError,
  type JevDeps,
  type Result,
} from '../types'
import { RECOMMEND_MAX_CALLS_PER_REGISTER, unevaluatedRecommendation } from '../recommend/taxonomy'
import { assertFetchableCandidateUrl } from './fetch-policy'
import { extractCandidateMetadata } from './metadata'
import { logResolvedRecommendation, resolveDeRecommendation, type RecommendBudget } from './recommend'

export type RegisterCandidateDeps = {
  readonly store: CandidateStore
  readonly fetchPage: FetchPage
  readonly now?: () => Date
  readonly sourceKind?: CandidateSourceKind
  readonly jevDeps?: JevDeps
  readonly evaluateRecommend?: EvaluateSystemOne
  readonly maxJevCalls?: number
}

function isoNow(now: () => Date): string {
  return now().toISOString()
}

function toPublicNotice(
  kind: 'registered' | 'duplicate' | 'paywalled' | 'fetch_failed',
): CandidateRegisterResult['notice'] {
  switch (kind) {
    case 'registered':
      return { kind, message: '候補に登録しました' }
    case 'duplicate':
      return { kind, message: '同じ記事はすでに候補にあります' }
    case 'paywalled':
      return { kind, message: '有料記事と判定したため、読書候補からは除外しました' }
    case 'fetch_failed':
      return { kind, message: 'ページを取得できませんでした' }
  }
}

async function persist(
  store: CandidateStore,
  submittedUrl: HttpUrl,
  discoveredAt: string,
  saved: CandidateArticle,
  sourceKind: CandidateSourceKind,
): Promise<void> {
  await store.put(saved)
  await store.addDiscovery({
    id: await candidateDiscoveryIdFrom({
      candidateId: saved.id,
      sourceKind,
      discoveredUrl: submittedUrl,
    }),
    candidateId: saved.id,
    sourceKind,
    discoveredUrl: submittedUrl,
    discoveredAt,
  })
}

function clipPointers(existing: CandidateArticle | null): Pick<
  CandidateArticle,
  'completedArticleId' | 'clipJobId' | 'clipRunId' | 'selectedAt' | 'recommendation'
> {
  return {
    completedArticleId: existing?.completedArticleId ?? null,
    clipJobId: existing?.clipJobId ?? null,
    clipRunId: existing?.clipRunId ?? null,
    selectedAt: existing?.selectedAt ?? null,
    recommendation: existing?.recommendation ?? unevaluatedRecommendation(),
  }
}

function savedCandidate(existing: CandidateArticle | null, incoming: CandidateArticle): CandidateArticle {
  if (existing === null) {
    return incoming
  }
  if (incoming.listingState === 'excluded' || existing.fetchStatus !== 'fetched') {
    return {
      ...incoming,
      discoveredAt: existing.discoveredAt,
      createdAt: existing.createdAt,
      ...clipPointers(existing),
    }
  }
  return {
    ...existing,
    title: incoming.title,
    outlet: incoming.outlet,
    publishedAt: incoming.publishedAt ?? existing.publishedAt,
    fullTextState:
      existing.fullTextState === 'confirmed_free' ? existing.fullTextState : incoming.fullTextState,
    updatedAt: incoming.updatedAt,
  }
}

async function persistJudged(
  saved: CandidateArticle,
  input: {
    readonly extractedHtml: string | null
    readonly paywalled: boolean
    readonly now: Date
    readonly budget: RecommendBudget
    readonly deps: RegisterCandidateDeps
    readonly submittedUrl: HttpUrl
    readonly discoveredAt: string
    readonly sourceKind: CandidateSourceKind
  },
): Promise<CandidateArticle> {
  const resolved = await resolveDeRecommendation({
    existing: saved.recommendation,
    extractedHtml: input.extractedHtml,
    title: saved.title,
    outlet: saved.outlet,
    canonicalUrl: saved.canonicalUrl,
    paywalled: input.paywalled,
    now: input.now,
    budget: input.budget,
    ...(input.deps.jevDeps === undefined ? {} : { jevDeps: input.deps.jevDeps }),
    ...(input.deps.evaluateRecommend === undefined ? {} : { evaluate: input.deps.evaluateRecommend }),
  })
  const judged: CandidateArticle = { ...saved, recommendation: resolved.recommendation }
  await persist(input.deps.store, input.submittedUrl, input.discoveredAt, judged, input.sourceKind)
  logResolvedRecommendation(judged, resolved.reused)
  return judged
}

export async function registerCandidate(
  submittedUrl: HttpUrl,
  deps: RegisterCandidateDeps,
): Promise<Result<CandidateRegisterResult, InvalidUrlError>> {
  const now = deps.now ?? (() => new Date())
  const discoveredAt = isoNow(now)
  const sourceKind = deps.sourceKind ?? CANDIDATE_SOURCE_KIND_MANUAL_URL
  const budget: RecommendBudget = { remainingCalls: deps.maxJevCalls ?? RECOMMEND_MAX_CALLS_PER_REGISTER }
  const fetchable = assertFetchableCandidateUrl(submittedUrl)
  if (!fetchable.ok) {
    return fetchable
  }

  const page = await deps.fetchPage(submittedUrl)
  if (!page.ok) {
    const host = new URL(submittedUrl).hostname
    const existing = await deps.store.getByCanonicalUrl(submittedUrl)
    const incoming: CandidateArticle = {
      id: existing?.id ?? (await candidateIdFromCanonicalUrl(submittedUrl)),
      canonicalUrl: submittedUrl,
      sourceUrl: submittedUrl,
      title: host,
      outlet: host,
      publishedAt: existing?.publishedAt ?? null,
      discoveredAt: existing?.discoveredAt ?? discoveredAt,
      fetchStatus: 'fetch_failed',
      listingState: 'listed',
      exclusionReason: null,
      fullTextState: 'unconfirmed',
      ...clipPointers(existing),
      createdAt: existing?.createdAt ?? discoveredAt,
      updatedAt: discoveredAt,
    }
    const judged = await persistJudged(savedCandidate(existing, incoming), {
      extractedHtml: null,
      paywalled: false,
      now: now(),
      budget,
      deps,
      submittedUrl,
      discoveredAt,
      sourceKind,
    })
    return ok({
      candidate: judged,
      duplicate: existing !== null,
      notice: toPublicNotice(existing !== null ? 'duplicate' : 'fetch_failed'),
    })
  }

  const metadata = extractCandidateMetadata(page.value)
  const extracted = metadata.paywalled ? null : await extractArticle(page.value)
  const fullTextState = metadata.paywalled
    ? 'unavailable'
    : extracted?.ok === true
      ? 'confirmed_free'
      : 'unconfirmed'
  const listingState = metadata.paywalled ? 'excluded' : 'listed'
  const existing = await deps.store.getByCanonicalUrl(metadata.canonicalUrl)
  const incoming: CandidateArticle = {
    id: existing?.id ?? (await candidateIdFromCanonicalUrl(metadata.canonicalUrl)),
    canonicalUrl: metadata.canonicalUrl,
    sourceUrl: submittedUrl,
    title: metadata.title,
    outlet: metadata.outlet,
    publishedAt: metadata.publishedAt ?? existing?.publishedAt ?? null,
    discoveredAt: existing?.discoveredAt ?? discoveredAt,
    fetchStatus: 'fetched',
    listingState,
    exclusionReason: metadata.paywalled ? 'paywalled' : null,
    fullTextState,
    ...clipPointers(existing),
    createdAt: existing?.createdAt ?? discoveredAt,
    updatedAt: discoveredAt,
  }
  const judged = await persistJudged(savedCandidate(existing, incoming), {
    extractedHtml: extracted?.ok === true ? extracted.value.contentHtml : null,
    paywalled: metadata.paywalled,
    now: now(),
    budget,
    deps,
    submittedUrl,
    discoveredAt,
    sourceKind,
  })
  const noticeKind = metadata.paywalled ? 'paywalled' : existing !== null ? 'duplicate' : 'registered'
  return ok({
    candidate: judged,
    duplicate: existing !== null,
    notice: toPublicNotice(noticeKind),
  })
}
