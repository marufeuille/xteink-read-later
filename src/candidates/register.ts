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
  type FetchPage,
  type HttpUrl,
  type InvalidUrlError,
  type Result,
} from '../types'
import { assertFetchableCandidateUrl } from './fetch-policy'
import { extractCandidateMetadata } from './metadata'

export type RegisterCandidateDeps = {
  readonly store: CandidateStore
  readonly fetchPage: FetchPage
  readonly now?: () => Date
  readonly sourceKind?: CandidateSourceKind
}

function isoNow(now: () => Date): string {
  return now().toISOString()
}

function toPublicNotice(
  kind: CandidateRegisterResult['notice']['kind'],
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

function savedCandidate(existing: CandidateArticle | null, incoming: CandidateArticle): CandidateArticle {
  if (existing === null) {
    return incoming
  }
  if (incoming.listingState === 'excluded' || existing.fetchStatus !== 'fetched') {
    return {
      ...incoming,
      discoveredAt: existing.discoveredAt,
      createdAt: existing.createdAt,
      completedArticleId: existing.completedArticleId,
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

export async function registerCandidate(
  submittedUrl: HttpUrl,
  deps: RegisterCandidateDeps,
): Promise<Result<CandidateRegisterResult, InvalidUrlError>> {
  const now = deps.now ?? (() => new Date())
  const discoveredAt = isoNow(now)
  const sourceKind = deps.sourceKind ?? CANDIDATE_SOURCE_KIND_MANUAL_URL
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
      completedArticleId: existing?.completedArticleId ?? null,
      createdAt: existing?.createdAt ?? discoveredAt,
      updatedAt: discoveredAt,
    }
    const saved = savedCandidate(existing, incoming)
    await persist(deps.store, submittedUrl, discoveredAt, saved, sourceKind)
    return ok({
      candidate: saved,
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
    completedArticleId: existing?.completedArticleId ?? null,
    createdAt: existing?.createdAt ?? discoveredAt,
    updatedAt: discoveredAt,
  }
  const saved = savedCandidate(existing, incoming)
  await persist(deps.store, submittedUrl, discoveredAt, saved, sourceKind)
  const noticeKind = metadata.paywalled ? 'paywalled' : existing !== null ? 'duplicate' : 'registered'
  return ok({
    candidate: saved,
    duplicate: existing !== null,
    notice: toPublicNotice(noticeKind),
  })
}
