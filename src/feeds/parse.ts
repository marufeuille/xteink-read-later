import type { HttpUrl, InvalidFeedError, ParsedFeed, Result } from '../types'
import { MAX_FEED_PARSE_ITEMS } from '../types'
import { err, ok, parseHttpUrl } from '../types'

const FEED_MIME_HINT = /rss|atom|xml|rdf/i

export function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 800).toLowerCase()
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf')
}

export function isFeedContentType(contentType: string): boolean {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime.length === 0) {
    return true
  }
  return FEED_MIME_HINT.test(mime) || mime === 'text/html' || mime === 'text/plain' || mime === 'application/octet-stream'
}

function decodeXmlEntities(value: string): string {
  const unwrapped = unwrapCdata(value)
  return unwrapped
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

function unwrapCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
}

function stripXmlNoise(xml: string): string {
  return xml.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!--[\s\S]*?-->/g, '')
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value === undefined || value.length === 0 ? null : decodeXmlEntities(value)
}

function allElements(xml: string, localName: string): readonly { readonly attrs: string; readonly inner: string }[] {
  const out: { attrs: string; inner: string }[] = []
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}\\s*>`,
    'gi',
  )
  for (const match of xml.matchAll(re)) {
    out.push({ attrs: match[1] ?? '', inner: match[2] ?? '' })
    if (out.length >= MAX_FEED_PARSE_ITEMS) {
      break
    }
  }
  return out
}

function firstElement(xml: string, localName: string): { readonly attrs: string; readonly inner: string } | null {
  return allElements(xml, localName)[0] ?? null
}

function textOf(xml: string, localName: string): string {
  const found = firstElement(xml, localName)
  if (found === null) {
    return ''
  }
  return decodeXmlEntities(unwrapCdata(found.inner).replace(/<[^>]+>/g, ' '))
}

function resolveHttpUrl(value: string, base: HttpUrl): HttpUrl | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  try {
    return parseHttpUrl(new URL(trimmed, base).href)
  } catch {
    return parseHttpUrl(trimmed)
  }
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

function rssItemLink(item: string, base: HttpUrl): HttpUrl | null {
  const linkText = textOf(item, 'link')
  const fromLink = resolveHttpUrl(linkText, base)
  if (fromLink !== null) {
    return fromLink
  }
  const guid = firstElement(item, 'guid')
  if (guid === null) {
    return null
  }
  const permalink = (attr(guid.attrs, 'isPermaLink') ?? 'true').toLowerCase()
  if (permalink === 'false') {
    return null
  }
  return resolveHttpUrl(decodeXmlEntities(guid.inner), base)
}

function atomLinks(block: string): readonly { readonly rel: string; readonly href: string }[] {
  const out: { rel: string; href: string }[] = []
  const re = /<(?:[\w.-]+:)?link\b([^>]*)\/?>/gi
  for (const match of block.matchAll(re)) {
    const attrs = match[1] ?? ''
    const href = attr(attrs, 'href')
    if (href === null) {
      continue
    }
    out.push({ rel: (attr(attrs, 'rel') ?? 'alternate').toLowerCase(), href })
  }
  return out
}

function atomHref(block: string, base: HttpUrl): HttpUrl | null {
  const links = atomLinks(block)
  const alternate = links.find((link) => link.rel === 'alternate') ?? links.find((link) => link.rel.length === 0)
  const chosen = alternate ?? links[0]
  if (chosen === undefined) {
    const idText = textOf(block, 'id')
    return resolveHttpUrl(idText, base)
  }
  return resolveHttpUrl(chosen.href, base)
}

function parseRss(xml: string, base: HttpUrl): Result<ParsedFeed, InvalidFeedError> {
  const channel = firstElement(xml, 'channel')
  const scope = channel?.inner ?? xml
  const items = allElements(scope, 'item').flatMap((item) => {
    const url = rssItemLink(item.inner, base)
    if (url === null) {
      return []
    }
    const title = textOf(item.inner, 'title')
    return [
      {
        url,
        title: title.length > 0 ? title : url,
        publishedAt: toIsoDate(textOf(item.inner, 'pubDate') || textOf(item.inner, 'date')),
      },
    ]
  })
  if (items.length === 0) {
    return err({ kind: 'invalid_feed', reason: 'フィードに記事 URL がありません', url: base })
  }
  const title = textOf(scope, 'title')
  const siteUrl = resolveHttpUrl(textOf(scope, 'link'), base)
  return ok({
    format: 'rss',
    title: title.length > 0 ? title : new URL(base).hostname,
    siteUrl,
    items,
  })
}

function parseAtom(xml: string, base: HttpUrl): Result<ParsedFeed, InvalidFeedError> {
  const feed = firstElement(xml, 'feed')
  const scope = feed?.inner ?? xml
  const items = allElements(scope, 'entry').flatMap((entry) => {
    const url = atomHref(entry.inner, base)
    if (url === null) {
      return []
    }
    const title = textOf(entry.inner, 'title')
    return [
      {
        url,
        title: title.length > 0 ? title : url,
        publishedAt: toIsoDate(textOf(entry.inner, 'published') || textOf(entry.inner, 'updated')),
      },
    ]
  })
  if (items.length === 0) {
    return err({ kind: 'invalid_feed', reason: 'フィードに記事 URL がありません', url: base })
  }
  const feedMeta = scope.replace(/<(?:[\w.-]+:)?entry\b[\s\S]*?<\/(?:[\w.-]+:)?entry\s*>/gi, '')
  const title = textOf(feedMeta, 'title')
  return ok({
    format: 'atom',
    title: title.length > 0 ? title : new URL(base).hostname,
    siteUrl: atomHref(feedMeta, base),
    items,
  })
}

export function parseFeed(xml: string, base: HttpUrl): Result<ParsedFeed, InvalidFeedError> {
  const cleaned = stripXmlNoise(xml)
  if (!looksLikeFeed(cleaned)) {
    return err({
      kind: 'invalid_feed',
      reason: 'RSS/Atom ではありません。フィード URL を指定してください',
      url: base,
    })
  }
  const head = cleaned.slice(0, 800).toLowerCase()
  if (head.includes('<rss') || head.includes('<rdf:rdf')) {
    return parseRss(cleaned, base)
  }
  if (head.includes('<feed')) {
    return parseAtom(cleaned, base)
  }
  return err({
    kind: 'invalid_feed',
    reason: 'RSS/Atom ではありません。フィード URL を指定してください',
    url: base,
  })
}
