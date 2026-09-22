import { parse } from 'node-html-parser'
import { looksLikeFeed } from '../../feeds/parse'
import type { FetchError, FetchedPage, HttpUrl, Result } from '../../types'
import { parseHttpUrl } from '../../types'
import { MIN_CONTENT_CHARS, PARSE_HTML_OPTIONS } from '../constants'
import type { SiteFetchRecovery, SiteRecoveryResult } from './recovery'

const POST_ID = /-([0-9a-f]{8,12})$/i
const BARE_POST_ID = /^[0-9a-f]{8,12}$/i
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'cdn',
  'cdn-cgi',
  'help',
  'link',
  'miro',
  'policy',
  'status',
  'about',
])

const RESERVED_SECTIONS = new Set([
  'about',
  'creators',
  'explore',
  'feed',
  'follow',
  'm',
  'me',
  'membership',
  'new-story',
  'p',
  'plans',
  'search',
  'sign-in',
  'signin',
  'tag',
  'tags',
  'topics',
])

const TRUNCATION =
  /continue reading on medium|read the full story|read more on medium|member-only story|available to medium members|this story is for medium members/i

const FULL_TEXT_SINGLE_BLOCK_CHARS = 1500
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'

export const MEDIUM_FEED_INCOMPLETE = 'Medium feed did not include the full article'

export type MediumArticleRef = {
  readonly feedUrl: HttpUrl
  readonly postId: string
}

export type FetchTextDocument = (
  url: HttpUrl,
  accept?: string,
) => Promise<Result<{ readonly text: string }, FetchError>>

type MediumFeedItem = {
  readonly postId: string | null
  readonly title: string
  readonly author: string | null
  readonly publishedAt: string | null
  readonly contentHtml: string | null
}

function postIdFromPath(pathname: string): string | null {
  const segment = pathname.split('/').filter((part) => part.length > 0).at(-1)
  if (segment === undefined) {
    return null
  }
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return null
  }
  const hyphenated = POST_ID.exec(decoded)
  if (hyphenated?.[1] !== undefined) {
    return hyphenated[1].toLowerCase()
  }
  return BARE_POST_ID.test(decoded) ? decoded.toLowerCase() : null
}

function feedUrlFor(path: string): HttpUrl | null {
  return parseHttpUrl(`https://medium.com/feed/${path}`)
}

function isName(value: string): boolean {
  return NAME.test(value) && value !== '.' && value !== '..'
}

export function mediumArticleRef(url: HttpUrl): MediumArticleRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  const segments = parsed.pathname.split('/').filter((part) => part.length > 0)
  const postId = postIdFromPath(parsed.pathname)
  if (postId === null) {
    return null
  }

  if (host === 'medium.com' || host === 'www.medium.com') {
    const [first, second] = segments
    if (first === undefined || second === undefined || segments.length !== 2) {
      return null
    }
    if (first.startsWith('@')) {
      const username = first.slice(1)
      if (!isName(username)) {
        return null
      }
      const feedUrl = feedUrlFor(`@${username}`)
      return feedUrl === null ? null : { feedUrl, postId }
    }
    if (!isName(first) || RESERVED_SECTIONS.has(first.toLowerCase())) {
      return null
    }
    const feedUrl = feedUrlFor(first)
    return feedUrl === null ? null : { feedUrl, postId }
  }

  if (!host.endsWith('.medium.com')) {
    return null
  }
  const username = host.slice(0, -'.medium.com'.length)
  if (username.includes('.') || RESERVED_SUBDOMAINS.has(username) || !isName(username)) {
    return null
  }
  if (segments.length !== 1) {
    return null
  }
  const feedUrl = feedUrlFor(`@${username}`)
  return feedUrl === null ? null : { feedUrl, postId }
}

function unwrapCdata(value: string): string {
  const match = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(value)
  return match?.[1] ?? value
}

function decodeXmlText(value: string): string {
  return unwrapCdata(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePointToChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePointToChar(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function codePointToChar(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return ''
  }
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function xmlHtml(value: string): string {
  const match = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(value)
  if (match?.[1] !== undefined) {
    return match[1].trim()
  }
  return decodeXmlText(value)
}

function taggedInner(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i')
  const match = pattern.exec(xml)
  return match?.[1] ?? null
}

function toIsoDate(value: string): string | null {
  if (value.length === 0) {
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return new Date(parsed).toISOString()
}

function postIdFromItem(item: string): string | null {
  const link = taggedInner(item, 'link')
  const guid = taggedInner(item, 'guid')
  for (const raw of [link, guid]) {
    if (raw === null) {
      continue
    }
    const text = decodeXmlText(raw)
    try {
      const id = postIdFromPath(new URL(text).pathname)
      if (id !== null) {
        return id
      }
    } catch {
      const id = postIdFromPath(text)
      if (id !== null) {
        return id
      }
    }
  }
  return null
}

export function readMediumFeedItems(xml: string): readonly MediumFeedItem[] {
  const cleaned = xml.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!--[\s\S]*?-->/g, '')
  if (!looksLikeFeed(cleaned)) {
    return []
  }
  const items: MediumFeedItem[] = []
  const re = /<(?:[\w.-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?item\s*>/gi
  for (const match of cleaned.matchAll(re)) {
    const item = match[1] ?? ''
    const content = taggedInner(item, 'content:encoded')
    const title = decodeXmlText(taggedInner(item, 'title') ?? '')
    const author = decodeXmlText(taggedInner(item, 'dc:creator') ?? taggedInner(item, 'creator') ?? '')
    const publishedAt = toIsoDate(decodeXmlText(taggedInner(item, 'pubDate') ?? taggedInner(item, 'date') ?? ''))
    items.push({
      postId: postIdFromItem(item),
      title,
      author: author.length > 0 ? author : null,
      publishedAt,
      contentHtml: content === null ? null : xmlHtml(content),
    })
    if (items.length >= 50) {
      break
    }
  }
  return items
}

export function mediumContentIsFull(html: string): boolean {
  if (TRUNCATION.test(html)) {
    return false
  }
  const root = parse(`<article>${html}</article>`, PARSE_HTML_OPTIONS)
  const blocks = root.querySelectorAll('p, h2, h3, h4, li, pre, blockquote')
  const texts = blocks.map((block) => block.text.replace(/\s+/g, ' ').trim()).filter((text) => text.length > 0)
  const chars = texts.join(' ').length
  if (chars < MIN_CONTENT_CHARS) {
    return false
  }
  return texts.length >= 2 || chars >= FULL_TEXT_SINGLE_BLOCK_CHARS
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function canonicalArticleUrl(url: HttpUrl): HttpUrl {
  const parsed = new URL(url)
  parsed.search = ''
  parsed.hash = ''
  const canonical = parseHttpUrl(parsed.href)
  return canonical ?? url
}

export function mediumArticleHtml(item: MediumFeedItem, pageUrl: HttpUrl): string | null {
  if (item.title.length === 0 || item.contentHtml === null || !mediumContentIsFull(item.contentHtml)) {
    return null
  }
  const canonical = canonicalArticleUrl(pageUrl)
  const author = item.author === null ? '' : `<meta name="author" content="${escapeAttr(item.author)}">`
  const published =
    item.publishedAt === null
      ? ''
      : `<meta property="article:published_time" content="${escapeAttr(item.publishedAt)}">`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeAttr(item.title)}</title>
<meta property="og:title" content="${escapeAttr(item.title)}">
${author}
${published}
<link rel="canonical" href="${escapeAttr(canonical)}">
</head>
<body>
<article>
${item.contentHtml}
</article>
</body>
</html>`
}

export function pageFromMediumFeed(xml: string, pageUrl: HttpUrl, postId: string): FetchedPage | null {
  const item = readMediumFeedItems(xml).find((entry) => entry.postId === postId) ?? null
  if (item === null) {
    return null
  }
  const html = mediumArticleHtml(item, pageUrl)
  if (html === null) {
    return null
  }
  return {
    requestedUrl: pageUrl,
    finalUrl: canonicalArticleUrl(pageUrl),
    contentType: 'text/html; charset=utf-8',
    html,
  }
}

export function createMediumFeedRecovery(fetchText: FetchTextDocument): SiteFetchRecovery {
  return {
    id: 'medium-feed',
    matches(url) {
      return mediumArticleRef(url) !== null
    },
    async recover(url): Promise<SiteRecoveryResult> {
      const ref = mediumArticleRef(url)
      if (ref === null) {
        return { outcome: 'pass' }
      }
      const feed = await fetchText(ref.feedUrl, FEED_ACCEPT)
      if (!feed.ok) {
        return { outcome: 'pass' }
      }
      if (!looksLikeFeed(feed.value.text)) {
        return { outcome: 'pass' }
      }
      const page = pageFromMediumFeed(feed.value.text, url, ref.postId)
      if (page === null) {
        return { outcome: 'unavailable', reason: MEDIUM_FEED_INCOMPLETE }
      }
      return { outcome: 'recovered', page }
    },
  }
}
