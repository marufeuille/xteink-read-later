import { digestSourceKey } from '../daily/select'
import { logDigestInterest, type DigestInterestLog } from '../log'
import type {
  CandidateId,
  DigestInterestSnapshot,
  DigestPublishedItem,
  DigestQrFetchRecord,
  DigestStore,
  HttpUrl,
} from '../types'
import { digestQrExpiresAt, issueDateFromDigestQrExpires } from './confirm-link'

export const DIGEST_INTEREST_LABELS = ['weak_positive', 'ordinary_or_below'] as const
export type DigestInterestLabel = (typeof DIGEST_INTEREST_LABELS)[number]

/** Relative rank only. Never a reason to drop a site. */
export type DigestSourceInterest = -1 | 0 | 1

export type DigestInterestItem = {
  readonly issueDate: string
  readonly candidateId: CandidateId
  readonly canonicalUrl: HttpUrl
  readonly title: string
  readonly label: DigestInterestLabel
  readonly fetchedAt: string | null
}

export function digestQrWindowOpen(issueDate: string, nowMs: number): boolean {
  try {
    return nowMs < digestQrExpiresAt(issueDate) * 1000
  } catch {
    return false
  }
}

/**
 * Labels only the published set. A QR fetch whose candidate is not in that issue
 * does not become a digest like.
 */
export function joinDigestInterest(snapshot: DigestInterestSnapshot): DigestInterestItem[] {
  const fetchedAt = new Map<string, string>()
  for (const fetch of snapshot.fetches) {
    fetchedAt.set(`${fetch.issueDate}\0${fetch.candidateId}`, fetch.fetchedAt)
  }
  return snapshot.published.map((item) => labeledItem(item, fetchedAt))
}

function labeledItem(
  item: DigestPublishedItem,
  fetchedAt: ReadonlyMap<string, string>,
): DigestInterestItem {
  const at = fetchedAt.get(`${item.date}\0${item.candidateId}`) ?? null
  return {
    issueDate: item.date,
    candidateId: item.candidateId,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    label: at === null ? 'ordinary_or_below' : 'weak_positive',
    fetchedAt: at,
  }
}

/**
 * +1 after a QR send, -1 only after the QR window closes with no send.
 * An open issue that has not been fetched yet stays 0.
 * The net for one site is clamped to ±1 so repeated misses stay a weak signal.
 */
export function digestSourceInterestPrior(
  items: readonly DigestInterestItem[],
  nowMs: number,
): ReadonlyMap<string, DigestSourceInterest> {
  const nets = new Map<string, number>()
  for (const item of items) {
    const delta = interestDelta(item, nowMs)
    const key = digestSourceKey({ canonicalUrl: item.canonicalUrl })
    nets.set(key, (nets.get(key) ?? 0) + delta)
  }
  const priors = new Map<string, DigestSourceInterest>()
  for (const [key, net] of nets) {
    if (net > 0) {
      priors.set(key, 1)
    } else if (net < 0) {
      priors.set(key, -1)
    }
  }
  return priors
}

function interestDelta(item: DigestInterestItem, nowMs: number): number {
  if (item.label === 'weak_positive') {
    return 1
  }
  return digestQrWindowOpen(item.issueDate, nowMs) ? 0 : -1
}

export async function recordDigestQrFetch(input: {
  readonly digestStore: DigestStore
  readonly candidateId: CandidateId
  readonly expiresAt: number
  readonly fetchedAt: string
}): Promise<DigestInterestLog> {
  const issueDate = issueDateFromDigestQrExpires(input.expiresAt)
  if (issueDate === null) {
    const entry = {
      result: 'ignored' as const,
      reason: 'invalid_expiry' as const,
      candidateId: input.candidateId,
    }
    logDigestInterest(entry)
    return { event: 'digest_interest', ...entry }
  }
  const outcome = await input.digestStore.recordPublishedQrFetch({
    issueDate,
    candidateId: input.candidateId,
    fetchedAt: input.fetchedAt,
  })
  if (outcome === 'not_published') {
    const entry = {
      result: 'ignored' as const,
      reason: 'not_in_issue' as const,
      issueDate,
      candidateId: input.candidateId,
    }
    logDigestInterest(entry)
    return { event: 'digest_interest', ...entry }
  }
  const entry = {
    result: outcome,
    label: 'weak_positive' as const,
    issueDate,
    candidateId: input.candidateId,
  }
  logDigestInterest(entry)
  return { event: 'digest_interest', ...entry }
}
