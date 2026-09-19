import { parse, HTMLElement } from 'node-html-parser'
import type {
  ExtractArticle,
  ExtractedContent,
  ExtractFailedError,
  FetchedPage,
  HttpUrl,
  Result,
} from '../types'
import { err, ok, parseHttpUrl } from '../types'
import { CONTENT_SELECTORS, MIN_CONTENT_CHARS, NOISE_SELECTOR, PARSE_HTML_OPTIONS } from './constants'
import { sanitizeContentHtml, visibleTextLength } from './sanitize-html'

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
  if (
    types.some((type) =>
      /Article|NewsArticle|BlogPosting|TechArticle|WebPage/i.test(type),
    )
  ) {
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

function authorFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  if (Array.isArray(value)) {
    const names = value
      .map((item) => authorFromUnknown(item))
      .filter((name): name is string => name !== null)
    return names.length > 0 ? names.join(', ') : null
  }
  if (isRecord(value) && typeof value.name === 'string' && value.name.trim().length > 0) {
    return value.name.trim()
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

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value !== undefined && value !== null && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function noiseClass(el: HTMLElement): boolean {
  const haystack = `${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase()
  return /(?:^|[\s_-])(?:ad|ads|advert|advertisement|sidebar|share|social|related|comment|comments|cookie|newsletter|popup|modal|nav|menu|breadcrumb|promo|cta|subscribe|recommended|popular)(?:$|[\s_-])/.test(
    haystack,
  )
}

function inProtectedCode(el: HTMLElement): boolean {
  return el.closest('pre') !== null || el.closest('code') !== null
}

function stripNoise(root: HTMLElement): void {
  for (const el of root.querySelectorAll(NOISE_SELECTOR)) {
    if (inProtectedCode(el)) {
      continue
    }
    if (el.closest('article') !== null && el.rawTagName.toLowerCase() === 'header') {
      continue
    }
    el.remove()
  }
  for (const el of [...root.querySelectorAll('header')]) {
    if (inProtectedCode(el) || el.closest('article') !== null) {
      continue
    }
    el.remove()
  }
  for (const el of [...root.querySelectorAll('*')]) {
    if (inProtectedCode(el)) {
      continue
    }
    if (noiseClass(el) && el.closest('article') === null) {
      el.remove()
    }
  }
}

function paragraphScore(el: HTMLElement): number {
  const blocks = el.querySelectorAll('p, h2, h3, h4, li, pre, blockquote')
  const text = blocks.map((block) => block.text.trim()).join(' ')
  const length = text.replace(/\s+/g, ' ').trim().length
  const linkText = el.querySelectorAll('a').reduce((sum, link) => sum + link.text.trim().length, 0)
  const density = length > 0 ? linkText / length : 1
  const haystack = `${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase()
  let score = length
  if (density > 0.45) {
    score *= 0.35
  }
  if (/comment|sidebar|related|share|footer|nav|promo|recommend/.test(haystack)) {
    score *= 0.2
  }
  if (/article|post|content|entry|story|markdown/.test(haystack)) {
    score *= 1.4
  }
  return score
}

function locationBonus(el: HTMLElement): number {
  if (el.getAttribute('itemprop') === 'articleBody' || el.closest('[itemprop="articleBody"]') !== null) {
    return 2.2
  }
  const tag = el.rawTagName.toLowerCase()
  if (tag === 'main' || el.getAttribute('role') === 'main' || el.closest('main, [role="main"]') !== null) {
    return 1.8
  }
  const haystack = `${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase()
  if (/featured|teaser|excerpt|preview|related|popular|sidebar/.test(haystack)) {
    return 0.25
  }
  if (el.closest('.featured, .teaser, .excerpt, .preview, aside') !== null) {
    return 0.25
  }
  return 1
}

function pickContentNode(root: HTMLElement): HTMLElement | null {
  const seen = new Set<HTMLElement>()
  const candidates: HTMLElement[] = []
  for (const selector of CONTENT_SELECTORS) {
    for (const el of root.querySelectorAll(selector)) {
      if (!seen.has(el)) {
        seen.add(el)
        candidates.push(el)
      }
    }
  }
  for (const el of root.querySelectorAll('article, section, div')) {
    if (!seen.has(el)) {
      seen.add(el)
      candidates.push(el)
    }
  }

  let best: HTMLElement | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    const score = paragraphScore(candidate) * locationBonus(candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return bestScore >= MIN_CONTENT_CHARS ? best : null
}

function documentBaseUrl(root: HTMLElement, finalUrl: HttpUrl): HttpUrl {
  const href = root.querySelector('base')?.getAttribute('href')?.trim()
  if (href === undefined || href.length === 0) {
    return finalUrl
  }
  try {
    const resolved = parseHttpUrl(new URL(href, finalUrl).href)
    return resolved ?? finalUrl
  } catch {
    return finalUrl
  }
}

export const extractArticle: ExtractArticle = async (
  page: FetchedPage,
): Promise<Result<ExtractedContent, ExtractFailedError>> => {
  const root = parse(page.html, PARSE_HTML_OPTIONS)
  const jsonLd = jsonLdNodes(root)
  const jsonLdArticle = jsonLd[0]

  const title = firstNonEmpty(
    metaValue(root, ['og:title', 'twitter:title']),
    typeof jsonLdArticle?.headline === 'string' ? jsonLdArticle.headline : null,
    root.querySelector('title')?.text,
    root.querySelector('h1')?.text,
  )
  const author = firstNonEmpty(
    authorFromUnknown(jsonLdArticle?.author),
    metaValue(root, ['author', 'article:author', 'og:article:author', 'twitter:creator']),
    root.querySelector('[rel="author"], [itemprop="author"]')?.text,
  )
  const publishedRaw = firstNonEmpty(
    typeof jsonLdArticle?.datePublished === 'string' ? jsonLdArticle.datePublished : null,
    metaValue(root, ['article:published_time', 'og:article:published_time', 'date', 'pubdate']),
    root.querySelector('time[datetime]')?.getAttribute('datetime'),
  )
  const publishedAt = publishedRaw !== null ? toIsoDate(publishedRaw) : null
  const canonicalUrl = canonicalFrom(root, page.finalUrl)
  const baseUrl = documentBaseUrl(root, page.finalUrl)

  stripNoise(root)
  const contentNode = pickContentNode(root)
  if (contentNode === null) {
    return err({
      kind: 'extract_failed',
      url: page.finalUrl,
      reason: 'No article body found',
    })
  }

  for (const el of [...contentNode.querySelectorAll('*')]) {
    if (inProtectedCode(el)) {
      continue
    }
    if (noiseClass(el)) {
      el.remove()
    }
  }

  const contentHtml = sanitizeContentHtml(contentNode, baseUrl)
  if (visibleTextLength(contentHtml) < MIN_CONTENT_CHARS) {
    return err({
      kind: 'extract_failed',
      url: page.finalUrl,
      reason: 'Extracted body was too short',
    })
  }

  const resolvedTitle = title ?? firstNonEmpty(contentNode.querySelector('h1')?.text)
  if (resolvedTitle === null) {
    return err({
      kind: 'extract_failed',
      url: page.finalUrl,
      reason: 'Missing title',
    })
  }

  return ok({
    title: resolvedTitle,
    author,
    publishedAt,
    sourceUrl: page.requestedUrl,
    canonicalUrl,
    contentHtml,
  })
}
