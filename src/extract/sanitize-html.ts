import { HTMLElement, NodeType, type Node } from 'node-html-parser'
import { parseHttpUrl, type HttpUrl } from '../types'

const ALLOWED_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'blockquote',
  'em',
  'strong',
  'b',
  'i',
  'a',
  'br',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'figure',
  'figcaption',
])

const VOID_TAGS = new Set(['br', 'hr'])
const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'pre',
  'blockquote',
  'table',
  'figure',
  'hr',
])

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function resolveHref(base: HttpUrl, href: string): string | null {
  try {
    const resolved = new URL(href, base).href
    return parseHttpUrl(resolved)
  } catch {
    return null
  }
}

function attributesFor(tag: string, el: HTMLElement, base: HttpUrl): string {
  if (tag === 'a') {
    const href = el.getAttribute('href')
    if (href === undefined || href.trim().length === 0) {
      return ''
    }
    const resolved = resolveHref(base, href.trim())
    return resolved === null ? '' : ` href="${escapeText(resolved)}"`
  }
  if (tag === 'code' || tag === 'pre') {
    const className = el.getAttribute('class')
    return className !== undefined && className.trim().length > 0
      ? ` class="${escapeText(className.trim())}"`
      : ''
  }
  if (tag === 'td' || tag === 'th') {
    const colspan = el.getAttribute('colspan')
    const rowspan = el.getAttribute('rowspan')
    let attrs = ''
    if (colspan !== undefined) {
      attrs += ` colspan="${escapeText(colspan)}"`
    }
    if (rowspan !== undefined) {
      attrs += ` rowspan="${escapeText(rowspan)}"`
    }
    return attrs
  }
  return ''
}

function serializeChildren(el: HTMLElement, base: HttpUrl): string {
  return el.childNodes.map((child) => serializeNode(child, base)).join('')
}

function serializeNode(node: Node, base: HttpUrl): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return escapeText(node.text)
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return ''
  }

  const tag = node.rawTagName.toLowerCase()
  if (tag === 'img') {
    const alt = node.getAttribute('alt')?.trim()
    return alt !== undefined && alt.length > 0 ? `<p>${escapeText(alt)}</p>` : ''
  }

  if (tag === 'div' || tag === 'section' || tag === 'span' || tag === 'picture') {
    const inner = serializeChildren(node, base)
    if (inner.trim().length === 0) {
      return ''
    }
    const hasBlock = node.childNodes.some((child) => {
      return (
        child instanceof HTMLElement && BLOCK_TAGS.has(child.rawTagName.toLowerCase())
      )
    })
    if (hasBlock || tag === 'span' || tag === 'picture') {
      return inner
    }
    return `<p>${inner}</p>`
  }

  if (!ALLOWED_TAGS.has(tag)) {
    return serializeChildren(node, base)
  }

  const inner = serializeChildren(node, base)
  const attrs = attributesFor(tag, node, base)
  if (tag === 'a' && attrs.length === 0) {
    return inner
  }
  if (VOID_TAGS.has(tag)) {
    return `<${tag}>`
  }
  return `<${tag}${attrs}>${inner}</${tag}>`
}

export function sanitizeContentHtml(root: HTMLElement, base: HttpUrl): string {
  return serializeChildren(root, base)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function visibleTextLength(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
}
