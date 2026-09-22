import { parse, type HTMLElement } from 'node-html-parser'
import { firstUsableHeading, pickArticleTitle } from '../extract/article-title'
import { PARSE_HTML_OPTIONS } from '../extract/constants'
import { parseHttpUrl, type FetchedPage, type HttpUrl } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectJsonLd(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLd(item, out)
    }
    return
  }
  if (!isRecord(value)) {
    return
  }
  if (Array.isArray(value['@graph'])) {
    collectJsonLd(value['@graph'], out)
  }
  const rawType = value['@type']
  const types = Array.isArray(rawType)
    ? rawType.map(String)
    : rawType === undefined
      ? []
      : [String(rawType)]
  if (types.some((type) => /Article|NewsArticle|BlogPosting|TechArticle|WebPage/i.test(type))) {
    out.push(value)
  }
}

function jsonLdNodes(root: HTMLElement): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = []
  for (const script of root.querySelectorAll('script')) {
    const type = script.getAttribute('type')?.toLowerCase()
    if (type !== 'application/ld+json') {
      continue
    }
    try {
      collectJsonLd(JSON.parse(script.text), nodes)
    } catch {
      // Ignore malformed JSON-LD.
    }
  }
  return nodes
}

function metaValue(root: HTMLElement, names: readonly string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  for (const meta of root.querySelectorAll('meta')) {
    const key = (
      meta.getAttribute('property') ??
      meta.getAttribute('name') ??
      meta.getAttribute('itemprop') ??
      ''
    ).toLowerCase()
    if (!wanted.has(key)) {
      continue
    }
    const content = meta.getAttribute('content')?.trim()
    if (content !== undefined && content.length > 0) {
      return content
    }
  }
  return null
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value !== undefined && value !== null && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function toIsoDate(value: string): string | null {
  const date = new Date(value.trim())
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toISOString()
}

function canonicalFrom(root: HTMLElement, fallback: HttpUrl): HttpUrl {
  for (const link of root.querySelectorAll('link')) {
    const rel = link.getAttribute('rel')?.toLowerCase()
    if (rel !== 'canonical') {
      continue
    }
    const href = link.getAttribute('href')?.trim()
    if (href === undefined || href.length === 0) {
      continue
    }
    try {
      const resolved = parseHttpUrl(new URL(href, fallback).href)
      if (resolved !== null) {
        return resolved
      }
    } catch {
      // Keep scanning.
    }
  }
  const ogUrl = metaValue(root, ['og:url'])
  if (ogUrl !== null) {
    try {
      const resolved = parseHttpUrl(new URL(ogUrl, fallback).href)
      if (resolved !== null) {
        return resolved
      }
    } catch {
      return fallback
    }
  }
  return fallback
}

function outletFrom(root: HTMLElement, jsonLd: Record<string, unknown>[], canonicalUrl: HttpUrl): string {
  const publisher = jsonLd
    .map((node) => {
      const value = node.publisher
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim()
      }
      if (isRecord(value) && typeof value.name === 'string' && value.name.trim() !== '') {
        return value.name.trim()
      }
      return null
    })
    .find((name): name is string => name !== null)
  const named = firstNonEmpty(metaValue(root, ['og:site_name', 'application-name']), publisher)
  if (named !== null) {
    return named
  }
  return new URL(canonicalUrl).hostname
}

function jsonLdAccessibleForFreeFalse(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonLdAccessibleForFreeFalse(item))
  }
  if (!isRecord(value)) {
    return false
  }
  const free = value.isAccessibleForFree
  if (free === false || free === 'False' || free === 'false') {
    return true
  }
  return jsonLdAccessibleForFreeFalse(value.hasPart)
}

export type CandidatePageMetadata = {
  readonly title: string
  readonly publishedAt: string | null
  readonly canonicalUrl: HttpUrl
  readonly outlet: string
  readonly paywalled: boolean
}

export function extractCandidateMetadata(page: FetchedPage): CandidatePageMetadata {
  const root = parse(page.html, PARSE_HTML_OPTIONS)
  const jsonLd = jsonLdNodes(root)
  const jsonLdArticle = jsonLd[0]
  const canonicalUrl = canonicalFrom(root, page.finalUrl)
  const publishedRaw = firstNonEmpty(
    typeof jsonLdArticle?.datePublished === 'string' ? jsonLdArticle.datePublished : null,
    metaValue(root, ['article:published_time', 'og:article:published_time', 'date', 'pubdate']),
    root.querySelector('time[datetime]')?.getAttribute('datetime'),
  )
  const title =
    pickArticleTitle({
      socialTitle: metaValue(root, ['og:title', 'twitter:title']),
      jsonLdHeadline: typeof jsonLdArticle?.headline === 'string' ? jsonLdArticle.headline : null,
      documentTitle: root.querySelector('title')?.text ?? null,
      heading: firstUsableHeading([...root.querySelectorAll('h1')].map((el) => el.text)),
      ogDescription: metaValue(root, ['og:description']),
    }) ?? new URL(canonicalUrl).hostname
  const contentTier = (metaValue(root, ['article:content_tier']) ?? '').toLowerCase()
  const paywalled =
    jsonLd.some((node) => jsonLdAccessibleForFreeFalse(node)) ||
    contentTier === 'locked' ||
    contentTier === 'paid' ||
    contentTier === 'subscriber' ||
    contentTier === 'members-only'
  return {
    title,
    publishedAt: publishedRaw !== null ? toIsoDate(publishedRaw) : null,
    canonicalUrl,
    outlet: outletFrom(root, jsonLd, canonicalUrl),
    paywalled,
  }
}
