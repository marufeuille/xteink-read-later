import {
  CANDIDATE_LIST_PAGE_SIZE,
  CANDIDATE_LIST_TIMEZONE,
  type CandidateArticle,
  type CandidateListBody,
  type CandidateListGroup,
  type CandidateListPage,
  type CandidatePublic,
} from '../types'

export const CANDIDATE_TIMEZONE_NOTE =
  '日付は Asia/Tokyo (UTC+9) の暦日で分けています。公開日が無い記事は「公開日不明」にします（発見日では代用しません）。'

export function toCandidatePublic(candidate: CandidateArticle): CandidatePublic {
  return {
    id: candidate.id,
    canonicalUrl: candidate.canonicalUrl,
    sourceUrl: candidate.sourceUrl,
    title: candidate.title,
    outlet: candidate.outlet,
    publishedAt: candidate.publishedAt,
    discoveredAt: candidate.discoveredAt,
    fetchStatus: candidate.fetchStatus,
    listingState: candidate.listingState,
    exclusionReason: candidate.exclusionReason,
    fullTextState: candidate.fullTextState,
    completedArticleId: candidate.completedArticleId,
  }
}

export function calendarDateInTimeZone(iso: string, timeZone: string): string {
  const date = new Date(iso)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function groupCandidatesByPublishedDate(
  items: readonly CandidateArticle[],
  timeZone: string = CANDIDATE_LIST_TIMEZONE,
): readonly CandidateListGroup[] {
  const groups: CandidateListGroup[] = []
  const index = new Map<string, number>()
  for (const item of items) {
    const date = item.publishedAt === null ? null : calendarDateInTimeZone(item.publishedAt, timeZone)
    const key = date ?? 'unknown'
    const existing = index.get(key)
    if (existing === undefined) {
      index.set(key, groups.length)
      groups.push({
        date,
        label: date === null ? '公開日不明' : date,
        items: [toCandidatePublic(item)],
      })
      continue
    }
    const group = groups[existing]
    if (group === undefined) {
      continue
    }
    groups[existing] = { ...group, items: [...group.items, toCandidatePublic(item)] }
  }
  return groups
}

export function parseListPage(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 1
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1
  }
  return parsed
}

export function toCandidateListBody(page: CandidateListPage, pageNumber: number): CandidateListBody {
  return {
    timezone: CANDIDATE_LIST_TIMEZONE,
    timezoneNote: CANDIDATE_TIMEZONE_NOTE,
    page: pageNumber,
    pageSize: page.limit,
    total: page.total,
    groups: groupCandidatesByPublishedDate(page.items),
  }
}

export function listOffset(pageNumber: number, pageSize: number = CANDIDATE_LIST_PAGE_SIZE): number {
  return (pageNumber - 1) * pageSize
}
