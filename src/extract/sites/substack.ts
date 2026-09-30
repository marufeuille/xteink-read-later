import type { HTMLElement } from 'node-html-parser'
import type { HttpUrl } from '../../types'
import { MIN_CONTENT_CHARS } from '../constants'
import { documentIsPaywalled } from '../paywall'

export const SUBSTACK_PAYWALL_REASON =
  'This Substack post is for paid subscribers, and the full article body was not included in the page'

function hostnameOf(pageUrl: HttpUrl): string {
  try {
    return new URL(pageUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function onSubstackHost(pageUrl: HttpUrl): boolean {
  const host = hostnameOf(pageUrl)
  return host === 'substack.com' || host.endsWith('.substack.com')
}

export function isSubstackPost(root: HTMLElement, pageUrl: HttpUrl): boolean {
  if (root.querySelector('article.newsletter-post, .available-content .body.markup') !== null) {
    return true
  }
  if (!onSubstackHost(pageUrl)) {
    return false
  }
  return root.querySelector('.body.markup, [data-component-name="Paywall"], [data-testid="paywall"]') !== null
}

function hasSubstackPaywallGate(root: HTMLElement): boolean {
  if (root.querySelector('[data-component-name="Paywall"], [data-testid="paywall"]') !== null) {
    return true
  }
  for (const el of root.querySelectorAll('.paywall, .paywall-title')) {
    const text = el.text.replace(/\s+/g, ' ').trim()
    if (/paid subscribers|founding members|subscribe to (?:read|continue|unlock)/i.test(text)) {
      return true
    }
  }
  return false
}

export function substackPaywallReason(root: HTMLElement, pageUrl: HttpUrl): string | null {
  if (!isSubstackPost(root, pageUrl)) {
    return null
  }
  if (hasSubstackPaywallGate(root) || documentIsPaywalled(root)) {
    return SUBSTACK_PAYWALL_REASON
  }
  return null
}

export function substackArticleBody(root: HTMLElement, pageUrl: HttpUrl): HTMLElement | null {
  if (!isSubstackPost(root, pageUrl)) {
    return null
  }
  const node =
    root.querySelector('.available-content .body.markup') ??
    root.querySelector('.body.markup') ??
    root.querySelector('article.newsletter-post')
  if (node === null) {
    return null
  }
  const text = node.text.replace(/\s+/g, ' ').trim()
  if (text.length < MIN_CONTENT_CHARS) {
    return null
  }
  return node
}
