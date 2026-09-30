import type { HTMLElement } from 'node-html-parser'

const PAYWALL_COPY =
  /subscribe to (?:keep|continue) reading|subscribe to read the rest|this (?:post|article|story) is for paid subscribers|members-only story/i

const LOCKED_TIERS = new Set(['locked', 'paid', 'subscriber', 'members-only'])

export const PAYWALL_EXTRACT_REASON =
  'The article is behind a paywall and the full text was not included in the page'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (Array.isArray(value['@graph']) && jsonLdAccessibleForFreeFalse(value['@graph'])) {
    return true
  }
  return jsonLdAccessibleForFreeFalse(value.hasPart)
}

function contentTier(root: HTMLElement): string {
  for (const meta of root.querySelectorAll('meta')) {
    const key = (
      meta.getAttribute('property') ??
      meta.getAttribute('name') ??
      meta.getAttribute('itemprop') ??
      ''
    ).toLowerCase()
    if (key !== 'article:content_tier') {
      continue
    }
    return (meta.getAttribute('content') ?? '').trim().toLowerCase()
  }
  return ''
}

export function documentIsPaywalled(root: HTMLElement): boolean {
  if (LOCKED_TIERS.has(contentTier(root))) {
    return true
  }
  for (const script of root.querySelectorAll('script')) {
    if (script.getAttribute('type')?.toLowerCase() !== 'application/ld+json') {
      continue
    }
    try {
      if (jsonLdAccessibleForFreeFalse(JSON.parse(script.text))) {
        return true
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  }
  return false
}

export function hasPaywallCopy(root: HTMLElement): boolean {
  return PAYWALL_COPY.test(root.text.replace(/\s+/g, ' '))
}
