import { parse } from 'node-html-parser'
import { PARSE_HTML_OPTIONS } from '../extract/constants'
import type { HttpUrl } from '../types'
import { parseHttpUrl } from '../types'

const FEED_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'text/xml']

function resolveHref(href: string, base: HttpUrl): HttpUrl | null {
  try {
    return parseHttpUrl(new URL(href, base).href)
  } catch {
    return parseHttpUrl(href)
  }
}

function typeScore(type: string): number {
  const mime = type.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime === 'application/atom+xml' || mime === 'application/rss+xml') {
    return 3
  }
  if (mime === 'application/rdf+xml' || mime.includes('rss') || mime.includes('atom')) {
    return 2
  }
  if (mime === 'text/xml' || mime === 'application/xml') {
    return 1
  }
  return 0
}

export function discoverFeedUrl(html: string, base: HttpUrl): HttpUrl | null {
  const root = parse(html, PARSE_HTML_OPTIONS)
  const candidates: { score: number; url: HttpUrl }[] = []
  for (const link of root.querySelectorAll('link')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    const relTokens = new Set(rel.split(/\s+/).filter((token) => token.length > 0))
    if (!relTokens.has('alternate') && !relTokens.has('feed')) {
      continue
    }
    const type = link.getAttribute('type') ?? ''
    const href = (link.getAttribute('href') ?? '').trim()
    if (href.length === 0) {
      continue
    }
    const score = typeScore(type)
    if (score === 0 && !FEED_TYPES.some((feedType) => type.toLowerCase().includes(feedType))) {
      continue
    }
    const url = resolveHref(href, base)
    if (url === null) {
      continue
    }
    candidates.push({ score: Math.max(score, 1), url })
  }
  candidates.sort((left, right) => right.score - left.score)
  return candidates[0]?.url ?? null
}
