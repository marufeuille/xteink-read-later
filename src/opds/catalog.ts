import { dailyDateFromInstant, isDailyCanonicalUrl, parseDailyDate } from '../daily/identity'
import { xmlEscape } from '../epub/xhtml'
import {
  asArticleId,
  DAILY_CANONICAL_PREFIX,
  isArticleId,
  type ArticleId,
  type ArticleMeta,
  type HttpUrl,
  type OpdsCatalog,
  type OpdsFeedKind,
  type OpdsLocation,
  type OpdsShelf,
} from '../types'

export const OPDS_CATALOG_TITLE = 'Xteink Read Later'
export const OPDS_NAVIGATION_TYPE = 'application/atom+xml;profile=opds-catalog;kind=navigation'
export const OPDS_CATALOG_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition'
export const OPDS_ACQUISITION_REL = 'http://opds-spec.org/acquisition'
export const OPDS_SUBSECTION_REL = 'subsection'
export const OPDS_CACHE_CONTROL = 'no-store'

const PURCHASED_CANONICAL_HOST = 'purchased.invalid'
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i

const SHELF_TITLE: Readonly<Record<OpdsShelf, string>> = {
  clip: 'clip',
  ebook: 'ebook',
}

type OpdsBucket = OpdsShelf | 'daily'

type OpdsDatedArticles = {
  readonly date: string
  readonly updated: string
  readonly articles: readonly ArticleMeta[]
}

type OpdsGroups = {
  readonly clip: readonly OpdsDatedArticles[]
  readonly ebook: readonly OpdsDatedArticles[]
  readonly daily: ArticleMeta | null
}

export function opdsDownloadPath(id: ArticleId): `/opds/download/${ArticleId}.epub` {
  return `/opds/download/${id}.epub`
}

export function opdsFilename(id: ArticleId): `${ArticleId}.epub` {
  return `${id}.epub`
}

export function originBase(origin: HttpUrl): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

export function opdsEntryHref(origin: HttpUrl, id: ArticleId): string {
  return `${originBase(origin)}/articles/${id}`
}

export function opdsAcquisitionHref(origin: HttpUrl, id: ArticleId): string {
  return `${originBase(origin)}${opdsDownloadPath(id)}`
}

export function opdsCatalogContentType(feedKind: OpdsFeedKind): string {
  const media = feedKind === 'navigation' ? OPDS_NAVIGATION_TYPE : OPDS_CATALOG_TYPE
  return `${media};charset=utf-8`
}

export function parseOpdsDownloadFile(file: string): ArticleId | null {
  if (!file.endsWith('.epub')) {
    return null
  }
  const id = file.slice(0, -'.epub'.length)
  return isArticleId(id) ? asArticleId(id) : null
}

export function parseOpdsCatalogPath(pathname: string): OpdsLocation | null {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (path === '/opds') {
    return { kind: 'root' }
  }
  const parts = path.split('/')
  if (parts[0] !== '' || parts[1] !== 'opds') {
    return null
  }
  const shelf = parts[2]
  if (shelf !== 'clip' && shelf !== 'ebook') {
    return null
  }
  if (parts.length === 3) {
    return { kind: 'shelf', shelf }
  }
  if (parts.length !== 4) {
    return null
  }
  const date = parseDailyDate(parts[3] ?? '')
  if (date === null) {
    return null
  }
  return { kind: 'date', shelf, date }
}

export function opdsCalendarDate(article: Pick<ArticleMeta, 'publishedAt' | 'createdAt'>): string | null {
  const published = article.publishedAt
  if (published !== null && published.trim().length > 0) {
    const instant = readableInstant(published)
    if (instant !== null) {
      return dailyDateFromInstant(instant)
    }
  }
  return calendarDateOf(article.createdAt)
}

export function buildOpdsCatalog(
  articles: readonly ArticleMeta[],
  origin: HttpUrl,
  location: OpdsLocation,
): OpdsCatalog | null {
  const groups = groupOpdsArticles(articles)
  if (location.kind === 'root') {
    return { xml: rootFeed(groups, origin), feedKind: 'navigation' }
  }
  const dated = groups[location.shelf]
  if (location.kind === 'shelf') {
    if (dated.length === 0) {
      return null
    }
    return { xml: shelfFeed(location.shelf, dated, origin), feedKind: 'navigation' }
  }
  const day = dated.find((group) => group.date === location.date)
  if (day === undefined) {
    return null
  }
  return { xml: dateFeed(day, origin, location.shelf), feedKind: 'acquisition' }
}

function readableInstant(value: string): Date | null {
  const trimmed = value.trim()
  if (DATE_ONLY.test(trimmed)) {
    if (parseDailyDate(trimmed) === null) {
      return null
    }
    return new Date(`${trimmed}T00:00:00.000Z`)
  }
  if (!DATE_TIME.test(trimmed)) {
    return null
  }
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date
}

function calendarDateOf(value: string): string | null {
  const instant = readableInstant(value)
  return instant === null ? null : dailyDateFromInstant(instant)
}

function opdsBucket(article: ArticleMeta): OpdsBucket {
  if (isDailyCanonicalUrl(article.canonicalUrl)) {
    return 'daily'
  }
  if (new URL(article.canonicalUrl).hostname === PURCHASED_CANONICAL_HOST) {
    return 'ebook'
  }
  return 'clip'
}

function dailyDateKey(article: ArticleMeta): string {
  return article.canonicalUrl.slice(DAILY_CANONICAL_PREFIX.length)
}

function compareUpdatedDesc(left: ArticleMeta, right: ArticleMeta): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1
  }
  if (left.id !== right.id) {
    return left.id < right.id ? 1 : -1
  }
  return 0
}

function isNewerDaily(candidate: ArticleMeta, current: ArticleMeta): boolean {
  const candidateDate = dailyDateKey(candidate)
  const currentDate = dailyDateKey(current)
  if (candidateDate !== currentDate) {
    return candidateDate > currentDate
  }
  return compareUpdatedDesc(candidate, current) < 0
}

function toDated(bucket: ReadonlyMap<string, ArticleMeta[]>): readonly OpdsDatedArticles[] {
  return [...bucket.entries()]
    .sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
    .flatMap(([date, items]) => {
      const articles = [...items].sort(compareUpdatedDesc)
      const updated = articles[0]?.updatedAt
      if (updated === undefined) {
        return []
      }
      return [{ date, updated, articles }]
    })
}

function groupOpdsArticles(articles: readonly ArticleMeta[]): OpdsGroups {
  const clip = new Map<string, ArticleMeta[]>()
  const ebook = new Map<string, ArticleMeta[]>()
  let daily: ArticleMeta | null = null
  for (const article of articles) {
    const bucket = opdsBucket(article)
    if (bucket === 'daily') {
      if (daily === null || isNewerDaily(article, daily)) {
        daily = article
      }
      continue
    }
    const date = opdsCalendarDate(article)
    if (date === null) {
      continue
    }
    const target = bucket === 'clip' ? clip : ebook
    const list = target.get(date)
    if (list === undefined) {
      target.set(date, [article])
    } else {
      list.push(article)
    }
  }
  return { clip: toDated(clip), ebook: toDated(ebook), daily }
}

function maxUpdated(groups: readonly OpdsDatedArticles[]): string {
  return groups.reduce(
    (newest, group) => (group.updated > newest ? group.updated : newest),
    groups[0]?.updated ?? '',
  )
}

function rootUpdated(groups: OpdsGroups): string {
  const stamps = [
    groups.clip.length === 0 ? null : maxUpdated(groups.clip),
    groups.ebook.length === 0 ? null : maxUpdated(groups.ebook),
    groups.daily?.updatedAt ?? null,
  ].filter((stamp): stamp is string => stamp !== null)
  if (stamps.length === 0) {
    return new Date().toISOString()
  }
  return stamps.reduce((newest, stamp) => (stamp > newest ? stamp : newest))
}

function shelfHref(origin: HttpUrl, shelf: OpdsShelf): string {
  return `${originBase(origin)}/opds/${shelf}`
}

function dateHref(origin: HttpUrl, shelf: OpdsShelf, date: string): string {
  return `${shelfHref(origin, shelf)}/${date}`
}

function atomFeed(input: {
  readonly href: string
  readonly title: string
  readonly updated: string
  readonly selfType: string
  readonly origin: HttpUrl
  readonly entries: string
}): string {
  const root = `${originBase(input.origin)}/opds`
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xmlEscape(input.href)}</id>
  <title>${xmlEscape(input.title)}</title>
  <updated>${xmlEscape(input.updated)}</updated>
  <author>
    <name>${xmlEscape(OPDS_CATALOG_TITLE)}</name>
  </author>
  <link rel="self" href="${xmlEscape(input.href)}" type="${xmlEscape(input.selfType)}"/>
  <link rel="start" href="${xmlEscape(root)}" type="${xmlEscape(OPDS_NAVIGATION_TYPE)}"/>${input.entries}
</feed>
`
}

function navigationEntry(input: {
  readonly href: string
  readonly title: string
  readonly updated: string
  readonly type: string
}): string {
  return `
  <entry>
    <id>${xmlEscape(input.href)}</id>
    <title>${xmlEscape(input.title)}</title>
    <updated>${xmlEscape(input.updated)}</updated>
    <link rel="${OPDS_SUBSECTION_REL}" href="${xmlEscape(input.href)}" type="${xmlEscape(input.type)}"/>
  </entry>`
}

function acquisitionEntry(article: ArticleMeta, origin: HttpUrl): string {
  const author =
    article.author !== null && article.author.length > 0
      ? `
    <author>
      <name>${xmlEscape(article.author)}</name>
    </author>`
      : ''
  const published =
    article.publishedAt !== null && article.publishedAt.length > 0
      ? `
    <published>${xmlEscape(article.publishedAt)}</published>`
      : ''
  return `
  <entry>
    <id>${xmlEscape(opdsEntryHref(origin, article.id))}</id>
    <title>${xmlEscape(article.title)}</title>
    <updated>${xmlEscape(article.updatedAt)}</updated>${published}${author}
    <dc:language>ja</dc:language>
    <link rel="alternate" href="${xmlEscape(article.canonicalUrl)}" type="text/html"/>
    <link rel="${OPDS_ACQUISITION_REL}" href="${xmlEscape(opdsAcquisitionHref(origin, article.id))}" type="application/epub+zip"/>
  </entry>`
}

function rootFeed(groups: OpdsGroups, origin: HttpUrl): string {
  const href = `${originBase(origin)}/opds`
  const shelves = (['clip', 'ebook'] as const).flatMap((shelf) => {
    const dated = groups[shelf]
    if (dated.length === 0) {
      return []
    }
    return [
      navigationEntry({
        href: shelfHref(origin, shelf),
        title: SHELF_TITLE[shelf],
        updated: maxUpdated(dated),
        type: OPDS_NAVIGATION_TYPE,
      }),
    ]
  })
  const daily = groups.daily === null ? '' : acquisitionEntry(groups.daily, origin)
  return atomFeed({
    href,
    title: OPDS_CATALOG_TITLE,
    updated: rootUpdated(groups),
    selfType: OPDS_NAVIGATION_TYPE,
    origin,
    entries: `${shelves.join('')}${daily}`,
  })
}

function shelfFeed(shelf: OpdsShelf, dated: readonly OpdsDatedArticles[], origin: HttpUrl): string {
  const entries = dated.map((group) =>
    navigationEntry({
      href: dateHref(origin, shelf, group.date),
      title: group.date,
      updated: group.updated,
      type: OPDS_CATALOG_TYPE,
    }),
  )
  return atomFeed({
    href: shelfHref(origin, shelf),
    title: SHELF_TITLE[shelf],
    updated: maxUpdated(dated),
    selfType: OPDS_NAVIGATION_TYPE,
    origin,
    entries: entries.join(''),
  })
}

function dateFeed(day: OpdsDatedArticles, origin: HttpUrl, shelf: OpdsShelf): string {
  return atomFeed({
    href: dateHref(origin, shelf, day.date),
    title: day.date,
    updated: day.updated,
    selfType: OPDS_CATALOG_TYPE,
    origin,
    entries: day.articles.map((article) => acquisitionEntry(article, origin)).join(''),
  })
}
