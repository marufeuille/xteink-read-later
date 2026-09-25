import type { CandidateArticle, DigestBucket, DigestBucketQuota, RecommendGrade } from '../types'
import { DIGEST_BUCKET_QUOTAS, DIGEST_BUCKETS, DIGEST_MAX_PER_SOURCE } from '../types'

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

/** Announcements and overviews stay in the candidate list. The issue wants practical detail. */
export function digestHasSubstance(candidate: CandidateArticle): boolean {
  return evaluatedOf(candidate)?.concrete === true
}

export function digestNeedsEvaluation(candidate: CandidateArticle): boolean {
  return isDigestEligible(candidate) && digestBucketOf(candidate) === null
}

/**
 * Company blogs share a host. Zenn counts the author or Publication, so one topic feed
 * is not treated as a single site.
 */
export function digestSourceKey(candidate: Pick<CandidateArticle, 'canonicalUrl'>): string {
  const url = new URL(candidate.canonicalUrl)
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'zenn.dev') {
    return host
  }
  const parts = url.pathname.split('/').filter((part) => part.length > 0)
  if (parts[0] === 'p' && parts[1] !== undefined) {
    return `zenn.dev/p/${parts[1].toLowerCase()}`
  }
  if (parts[0] !== undefined) {
    return `zenn.dev/${parts[0].toLowerCase()}`
  }
  return host
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

function compareNewest(left: CandidateArticle, right: CandidateArticle): number {
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

export function digestSourceAtCap(
  candidates: Iterable<CandidateArticle>,
  sourceKey: string,
  usedCanonicalUrls: ReadonlySet<string>,
): boolean {
  let count = 0
  for (const candidate of candidates) {
    if (usedCanonicalUrls.has(candidate.canonicalUrl)) {
      continue
    }
    if (!isDigestEligible(candidate) || !digestHasSubstance(candidate) || digestSourceKey(candidate) !== sourceKey) {
      continue
    }
    count += 1
    if (count >= DIGEST_MAX_PER_SOURCE) {
      return true
    }
  }
  return false
}

/** Newest article first inside a site, then one article from each site in turn. */
export function orderDigestEvaluations(candidates: readonly CandidateArticle[]): CandidateArticle[] {
  const groups = new Map<string, CandidateArticle[]>()
  for (const candidate of candidates) {
    const key = digestSourceKey(candidate)
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, [candidate])
    } else {
      group.push(candidate)
    }
  }
  const ordered = [...groups.entries()]
    .map(([key, items]) => ({ key, items: [...items].sort(compareNewest) }))
    .sort((left, right) => {
      const newestLeft = left.items[0]
      const newestRight = right.items[0]
      if (newestLeft === undefined || newestRight === undefined) {
        return left.key < right.key ? -1 : 1
      }
      const byNewest = compareNewest(newestLeft, newestRight)
      if (byNewest !== 0) {
        return byNewest
      }
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    })
  const result: CandidateArticle[] = []
  for (let index = 0; ; index += 1) {
    let added = false
    for (const group of ordered) {
      const item = group.items[index]
      if (item !== undefined) {
        result.push(item)
        added = true
      }
    }
    if (!added) {
      return result
    }
  }
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
    if (
      !isDigestEligible(candidate) ||
      !digestHasSubstance(candidate) ||
      input.usedCanonicalUrls.has(candidate.canonicalUrl)
    ) {
      continue
    }
    const bucket = digestBucketOf(candidate)
    if (bucket !== null) {
      buckets[bucket].push(candidate)
    }
  }
  const selected: CandidateArticle[] = []
  const sourceCounts = new Map<string, number>()
  for (const bucket of DIGEST_BUCKETS) {
    const ranked = [...buckets[bucket]].sort(compareDigestCandidates)
    let taken = 0
    for (const candidate of ranked) {
      if (taken >= quotas[bucket].max) {
        break
      }
      const key = digestSourceKey(candidate)
      const usedBySource = sourceCounts.get(key) ?? 0
      if (usedBySource >= DIGEST_MAX_PER_SOURCE) {
        continue
      }
      selected.push(candidate)
      sourceCounts.set(key, usedBySource + 1)
      taken += 1
    }
  }
  return selected
}

export function digestSelectionSaturated(
  candidates: readonly CandidateArticle[],
  usedCanonicalUrls: ReadonlySet<string>,
  quotas: Readonly<Record<DigestBucket, DigestBucketQuota>> = DIGEST_BUCKET_QUOTAS,
): boolean {
  return digestQuotasFilled(
    countDigestBuckets(selectDigestCandidates(candidates, { usedCanonicalUrls, quotas })),
    quotas,
  )
}
