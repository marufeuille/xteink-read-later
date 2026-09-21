import { opdsAcquisitionHref, opdsEntryHref, opdsFilename } from '../opds/catalog'
import { articleIdFromCanonicalUrl, parseHttpUrl, type HttpUrl } from '../types'
import {
  DAILY_CANONICAL_PREFIX,
  DAILY_TIMEZONE,
  type DailyIdentityComparison,
  type DailyIssueIdentity,
} from '../types/daily'

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseDailyDate(value: string): string | null {
  const match = DATE_PATTERN.exec(value)
  if (match === null) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null
  }
  return value
}

function requireDailyDate(date: string): string {
  const parsed = parseDailyDate(date)
  if (parsed === null) {
    throw new TypeError(`Invalid daily date: ${date}`)
  }
  return parsed
}

export function dailyDateFromInstant(now: Date, timeZone: string = DAILY_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function dailyCanonicalUrl(date: string): HttpUrl {
  const parsedDate = requireDailyDate(date)
  const url = parseHttpUrl(`${DAILY_CANONICAL_PREFIX}${parsedDate}`)
  if (url === null) {
    throw new TypeError(`Invalid daily canonical URL for ${parsedDate}`)
  }
  return url
}

export function isDailyCanonicalUrl(value: string): boolean {
  if (!value.startsWith(DAILY_CANONICAL_PREFIX)) {
    return false
  }
  return parseDailyDate(value.slice(DAILY_CANONICAL_PREFIX.length)) !== null
}

export function dailyEpubIdentifier(date: string): string {
  return `urn:xteink:daily:${requireDailyDate(date)}`
}

export function dailyTitle(date: string): string {
  return `まとめ ${requireDailyDate(date)}`
}

export function dailyPublishedAt(date: string): string {
  return new Date(`${requireDailyDate(date)}T00:00:00+09:00`).toISOString()
}

export async function dailyIssueIdentity(input: {
  readonly date: string
  readonly origin: HttpUrl
}): Promise<DailyIssueIdentity> {
  const date = requireDailyDate(input.date)
  const canonicalUrl = dailyCanonicalUrl(date)
  const articleId = await articleIdFromCanonicalUrl(canonicalUrl)
  return {
    date,
    articleId,
    canonicalUrl,
    opdsEntryId: opdsEntryHref(input.origin, articleId),
    acquisitionUrl: opdsAcquisitionHref(input.origin, articleId),
    filename: opdsFilename(articleId),
    epubIdentifier: dailyEpubIdentifier(date),
    title: dailyTitle(date),
    publishedAt: dailyPublishedAt(date),
  }
}

export function compareDailyIdentities(
  left: DailyIssueIdentity,
  right: DailyIssueIdentity,
): DailyIdentityComparison {
  return {
    left,
    right,
    sameArticleId: left.articleId === right.articleId,
    sameOpdsEntryId: left.opdsEntryId === right.opdsEntryId,
    sameAcquisitionUrl: left.acquisitionUrl === right.acquisitionUrl,
    sameFilename: left.filename === right.filename,
    sameEpubIdentifier: left.epubIdentifier === right.epubIdentifier,
  }
}
