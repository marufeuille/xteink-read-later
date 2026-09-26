import {
  CANDIDATE_LIST_PAGE_SIZE,
  CANDIDATE_LIST_TIMEZONE,
  EMPTY_CANDIDATE_LIST_FILTERS,
  type CandidateArticle,
  type CandidateListBody,
  type CandidateListFilters,
  type CandidateListGroup,
  type CandidateListPage,
  type CandidatePublic,
} from '../types'
import { toCandidatePublic } from './delivery'

export { toCandidatePublic } from './delivery'

export const CANDIDATE_TIMEZONE_NOTE =
  '日付は Asia/Tokyo (UTC+9) の暦日です。公開日が無い記事は「公開日不明」にします（発見日では代用しません）。'

export function calendarDateInTimeZone(iso: string, timeZone: string): string {
  const date = new Date(iso)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function publishedInstant(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null
  }
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export function compareListedByPublishedDate(
  left: { readonly publishedAt: string | null; readonly discoveredAt: string; readonly id: string },
  right: { readonly publishedAt: string | null; readonly discoveredAt: string; readonly id: string },
): number {
  const leftTime = publishedInstant(left.publishedAt)
  const rightTime = publishedInstant(right.publishedAt)
  if (leftTime === null || rightTime === null) {
    if (leftTime !== rightTime) {
      return leftTime === null ? 1 : -1
    }
  } else if (leftTime !== rightTime) {
    return rightTime - leftTime
  }
  if (left.discoveredAt !== right.discoveredAt) {
    return left.discoveredAt < right.discoveredAt ? 1 : -1
  }
  if (left.id !== right.id) {
    return left.id < right.id ? 1 : -1
  }
  return 0
}

export function groupPublicCandidatesByPublishedDate(
  items: readonly CandidatePublic[],
  timeZone: string = CANDIDATE_LIST_TIMEZONE,
): readonly CandidateListGroup[] {
  const groups: CandidateListGroup[] = []
  const index = new Map<string, number>()
  for (const item of [...items].sort(compareListedByPublishedDate)) {
    const date = item.publishedAt === null ? null : calendarDateInTimeZone(item.publishedAt, timeZone)
    const key = date ?? 'unknown'
    const existing = index.get(key)
    if (existing === undefined) {
      index.set(key, groups.length)
      groups.push({
        date,
        label: date === null ? '公開日不明' : date,
        items: [item],
      })
      continue
    }
    const group = groups[existing]
    if (group === undefined) {
      continue
    }
    groups[existing] = { ...group, items: [...group.items, item] }
  }
  return groups
}

export function groupCandidatesByPublishedDate(
  items: readonly CandidateArticle[],
  timeZone: string = CANDIDATE_LIST_TIMEZONE,
): readonly CandidateListGroup[] {
  return groupPublicCandidatesByPublishedDate(
    items.map((item) => toCandidatePublic(item)),
    timeZone,
  )
}

export function toCandidateListBody(
  page: CandidateListPage,
  pageNumber: number,
  filters: CandidateListFilters = EMPTY_CANDIDATE_LIST_FILTERS,
): CandidateListBody {
  return toCandidateListBodyFromPublic(
    page.items.map((item) => toCandidatePublic(item)),
    page.total,
    page.limit,
    pageNumber,
    filters,
    page.outlets,
  )
}

export function toCandidateListBodyFromPublic(
  items: readonly CandidatePublic[],
  total: number,
  pageSize: number,
  pageNumber: number,
  filters: CandidateListFilters = EMPTY_CANDIDATE_LIST_FILTERS,
  outlets: readonly string[] = [],
): CandidateListBody {
  return {
    timezone: CANDIDATE_LIST_TIMEZONE,
    timezoneNote: CANDIDATE_TIMEZONE_NOTE,
    page: pageNumber,
    pageSize,
    total,
    groups: groupPublicCandidatesByPublishedDate(items),
    filters,
    outlets,
  }
}

export function listOffset(pageNumber: number, pageSize: number = CANDIDATE_LIST_PAGE_SIZE): number {
  return (pageNumber - 1) * pageSize
}
