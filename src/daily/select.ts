import type { CandidateArticle, DigestBucket, DigestBucketQuota, RecommendGrade } from '../types'
import { DIGEST_BUCKET_QUOTAS, DIGEST_BUCKETS } from '../types'

const DIGEST_BUCKET_BY_GRADE: Readonly<Record<RecommendGrade, DigestBucket>> = {
  recommended: 'deep',
  related: 'tech',
  low_priority: 'general',
}

export function isDigestEligible(candidate: CandidateArticle): boolean {
  return (
    candidate.listingState === 'listed' &&
    candidate.fetchStatus === 'fetched' &&
    candidate.fullTextState === 'confirmed_free' &&
    candidate.exclusionReason === null
  )
}

export function digestBucketOfGrade(grade: RecommendGrade): DigestBucket {
  return DIGEST_BUCKET_BY_GRADE[grade]
}

function evaluatedOf(candidate: CandidateArticle) {
  return candidate.recommendation.status === 'evaluated' ? candidate.recommendation : null
}

export function digestBucketOf(candidate: CandidateArticle): DigestBucket | null {
  const evaluated = evaluatedOf(candidate)
  return evaluated === null ? null : digestBucketOfGrade(evaluated.grade)
}

export function digestNeedsEvaluation(candidate: CandidateArticle): boolean {
  return isDigestEligible(candidate) && digestBucketOf(candidate) === null
}

function flagScore(candidate: CandidateArticle, flag: 'concrete' | 'verification'): number {
  return evaluatedOf(candidate)?.[flag] ? 1 : 0
}

function reverseCompare(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return left < right ? 1 : -1
}

function compareDigestCandidates(left: CandidateArticle, right: CandidateArticle): number {
  const byConcrete = flagScore(right, 'concrete') - flagScore(left, 'concrete')
  if (byConcrete !== 0) {
    return byConcrete
  }
  const byVerification = flagScore(right, 'verification') - flagScore(left, 'verification')
  if (byVerification !== 0) {
    return byVerification
  }
  const byConfidence = (evaluatedOf(right)?.confidence ?? 0) - (evaluatedOf(left)?.confidence ?? 0)
  if (byConfidence !== 0) {
    return byConfidence
  }
  const byDiscovered = reverseCompare(left.discoveredAt, right.discoveredAt)
  if (byDiscovered !== 0) {
    return byDiscovered
  }
  return reverseCompare(left.id, right.id)
}

export function countDigestBuckets(
  candidates: Iterable<CandidateArticle>,
): Readonly<Record<DigestBucket, number>> {
  const counts: Record<DigestBucket, number> = { deep: 0, tech: 0, general: 0 }
  for (const candidate of candidates) {
    const bucket = digestBucketOf(candidate)
    if (bucket !== null) {
      counts[bucket] += 1
    }
  }
  return counts
}

export function digestQuotasFilled(
  counts: Readonly<Record<DigestBucket, number>>,
  quotas: Readonly<Record<DigestBucket, DigestBucketQuota>> = DIGEST_BUCKET_QUOTAS,
): boolean {
  return DIGEST_BUCKETS.every((bucket) => counts[bucket] >= quotas[bucket].max)
}

export function selectDigestCandidates(
  candidates: readonly CandidateArticle[],
  input: {
    readonly usedCanonicalUrls: ReadonlySet<string>
    readonly quotas?: Readonly<Record<DigestBucket, DigestBucketQuota>>
  },
): CandidateArticle[] {
  const quotas = input.quotas ?? DIGEST_BUCKET_QUOTAS
  const buckets: Record<DigestBucket, CandidateArticle[]> = { deep: [], tech: [], general: [] }
  for (const candidate of candidates) {
    if (!isDigestEligible(candidate) || input.usedCanonicalUrls.has(candidate.canonicalUrl)) {
      continue
    }
    const bucket = digestBucketOf(candidate)
    if (bucket !== null) {
      buckets[bucket].push(candidate)
    }
  }
  return DIGEST_BUCKETS.flatMap((bucket) =>
    buckets[bucket].sort(compareDigestCandidates).slice(0, quotas[bucket].max),
  )
}
