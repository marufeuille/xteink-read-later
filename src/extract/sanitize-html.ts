import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser'
import { parseHttpUrl, type HttpUrl } from '../types'
import { PARSE_HTML_OPTIONS } from './constants'
import {
  imgAltText,
  isChartTickItemList,
  isLoneChartTick,
  stripChartTickMarkdown,
  stripPageCliWarnings,
  stripXmlIllegalChars,
} from './xml-text'

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

const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'nav',
  'footer',
  'aside',
  'template',
  'video',
  'audio',
  'source',
  'track',
  'link',
  'meta',
])

const CHROME_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
])

const ADS_CLASS_RE =
  /(?:^|[\s_-])(?:ad|ads|advert|advertisement|sidebar|share|social|related|comment|comments|cookie|newsletter|popup|modal|nav|menu|breadcrumb|promo|cta|subscribe|recommended|popular)(?:$|[\s_-])/

const LINK_CHROME_TAGS = new Set(['div', 'section', 'header', 'nav', 'ul', 'ol', 'aside'])
const SOLO_NAV_CHROME = /^(back|home|menu)$/i
const CHROME_PHRASES = [
  'sign in',
  'log in',
  'log out',
  'sign out',
  'sign up',
  'join waitlist',
  'join the waitlist',
  'join wait list',
  'privacy policy',
  'terms of use',
  'terms of service',
] as const

const WRAPPER_TAGS = new Set(['div', 'section', 'span', 'picture', 'article', 'main', 'header'])

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

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

type SerializeCtx = {
  readonly base: HttpUrl
  readonly inPre: boolean
  readonly list: 'ul' | 'ol' | null
  readonly index: number
}

function escapeText(value: string): string {
  return stripXmlIllegalChars(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function collapseText(value: string): string {
  return value.replace(/\s+/g, ' ')
}

function normalizeBlocks(value: string): string {
  return value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function resolveHref(base: HttpUrl, href: string): string | null {
  try {
    const resolved = new URL(href, base).href
    return parseHttpUrl(resolved)
  } catch {
    return null
  }
}

export function isAdsLikeClass(el: HTMLElement): boolean {
  const haystack = `${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase()
  return ADS_CLASS_RE.test(haystack)
}

export function isAriaHidden(el: HTMLElement): boolean {
  const value = (el.getAttribute('aria-hidden') ?? '').trim().toLowerCase()
  return value === 'true' || value === '1'
}

function listItemTexts(el: HTMLElement): string[] {
  const items: string[] = []
  for (const child of el.childNodes) {
    if (child instanceof HTMLElement && child.rawTagName.toLowerCase() === 'li') {
      items.push(child.text.replace(/\s+/g, ' ').trim())
    }
  }
  return items
}

export function isChartTickList(el: HTMLElement): boolean {
  const tag = el.rawTagName.toLowerCase()
  if (tag !== 'ol' && tag !== 'ul') {
    return false
  }
  return isChartTickItemList(listItemTexts(el))
}

function collapsedText(el: HTMLElement): string {
  return el.text.replace(/\s+/g, ' ').trim()
}

export function isChromePhraseText(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (normalized.length === 0 || normalized.length > 80) {
    return false
  }
  const phrases = [...CHROME_PHRASES].sort((left, right) => right.length - left.length)
  let rest = normalized
  let matched = 0
  while (rest.length > 0) {
    const phrase = phrases.find((item) => rest === item || rest.startsWith(`${item} `))
    if (phrase === undefined) {
      return false
    }
    matched += 1
    rest = rest.slice(phrase.length).trim()
  }
  return matched >= 1
}

export function isSoloNavChrome(el: HTMLElement): boolean {
  const tag = el.rawTagName.toLowerCase()
  if (!['div', 'section', 'p', 'header'].includes(tag)) {
    return false
  }
  const text = collapsedText(el)
  if (text.length === 0 || text.length > 32) {
    return false
  }
  const normalized = text.replace(/^[∵←<\s]+/, '').trim()
  return SOLO_NAV_CHROME.test(normalized)
}

export function isLinkChrome(el: HTMLElement): boolean {
  const tag = el.rawTagName.toLowerCase()
  if (!LINK_CHROME_TAGS.has(tag)) {
    return false
  }
  const links = el.querySelectorAll('a')
  if (links.length < 3) {
    return false
  }
  let substantial = 0
  for (const block of el.querySelectorAll('p, h1, h2, h3, h4, li, pre, blockquote')) {
    const text = collapsedText(block)
    if (text.length < 40) {
      continue
    }
    substantial += 1
    if (substantial >= 2) {
      return false
    }
  }
  const text = collapsedText(el)
  if (text.length === 0 || text.length > 320) {
    return false
  }
  const linkText = links.reduce((sum, link) => sum + collapsedText(link).length, 0)
  return linkText / text.length >= 0.55
}

function inProtectedCode(el: HTMLElement): boolean {
  return el.closest('pre') !== null || el.closest('code') !== null
}

function chromeRole(el: HTMLElement): boolean {
  const role = (el.getAttribute('role') ?? '').trim().toLowerCase()
  return CHROME_ROLES.has(role)
}

function shouldDropElement(el: HTMLElement): boolean {
  const tag = el.rawTagName.toLowerCase()
  if (DROP_TAGS.has(tag) || chromeRole(el) || isAriaHidden(el)) {
    return true
  }
  if (inProtectedCode(el)) {
    return false
  }
  if (isAdsLikeClass(el) || isChartTickList(el) || isLinkChrome(el) || isSoloNavChrome(el)) {
    return true
  }
  if ((tag === 'p' || tag === 'li') && isLoneChartTick(el.text)) {
    return true
  }
  if ((tag === 'p' || tag === 'div') && isChromePhraseText(collapsedText(el))) {
    return true
  }
  return false
}

function languageClass(el: HTMLElement): string {
  const className = el.getAttribute('class') ?? ''
  const match = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]+)/.exec(className)
  return match?.[1] ?? ''
}

function imgFallback(el: HTMLElement): string {
  return imgAltText(el.getAttribute('alt') ?? '')
}

function attributesFor(tag: string, el: HTMLElement, base: HttpUrl): string {
  if (tag === 'a') {
    const href = el.getAttribute('href')
    if (href === undefined || href.trim().length === 0) {
      return ''
    }
    const resolved = resolveHref(base, href.trim())
    return resolved === null ? '' : ` href="${escapeAttr(resolved)}"`
  }
  if (tag === 'code' || tag === 'pre') {
    const className = el.getAttribute('class')
    return className !== undefined && className.trim().length > 0
      ? ` class="${escapeAttr(className.trim())}"`
      : ''
  }
  if (tag === 'td' || tag === 'th') {
    const colspan = el.getAttribute('colspan')
    const rowspan = el.getAttribute('rowspan')
    let attrs = ''
    if (colspan !== undefined) {
      attrs += ` colspan="${escapeAttr(colspan)}"`
    }
    if (rowspan !== undefined) {
      attrs += ` rowspan="${escapeAttr(rowspan)}"`
    }
    return attrs
  }
  return ''
}

function htmlChildren(el: HTMLElement, ctx: SerializeCtx): string {
  return el.childNodes.map((child) => htmlNode(child, ctx)).join('')
}

function htmlNode(node: Node, ctx: SerializeCtx): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    const text = ctx.inPre ? node.text : collapseText(node.text)
    return escapeText(text)
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return ''
  }

  if (shouldDropElement(node)) {
    return ''
  }

  const tag = node.rawTagName.toLowerCase()
  const nextCtx: SerializeCtx =
    tag === 'pre' || tag === 'code' ? { ...ctx, inPre: true } : ctx

  if (tag === 'img') {
    const alt = imgFallback(node)
    return alt.length > 0 ? escapeText(alt) : ''
  }

  if (WRAPPER_TAGS.has(tag)) {
    const inner = htmlChildren(node, nextCtx)
    if (inner.trim().length === 0) {
      return ''
    }
    const hasBlock = node.childNodes.some((child) => {
      return child instanceof HTMLElement && BLOCK_TAGS.has(child.rawTagName.toLowerCase())
    })
    if (hasBlock || tag === 'span' || tag === 'picture') {
      return inner
    }
    return `<p>${inner}</p>`
  }

  if (!ALLOWED_TAGS.has(tag)) {
    return htmlChildren(node, nextCtx)
  }

  const inner = htmlChildren(node, nextCtx)
  const attrs = attributesFor(tag, node, ctx.base)
  if (tag === 'a' && attrs.length === 0) {
    return inner
  }
  if (VOID_TAGS.has(tag)) {
    return `<${tag}>`
  }
  if (
    inner.replace(/<[^>]+>/g, '').trim().length === 0 &&
    (tag === 'figure' || tag === 'figcaption' || tag === 'ul' || tag === 'ol' || tag === 'p')
  ) {
    return ''
  }
  return `<${tag}${attrs}>${inner}</${tag}>`
}

function markdownChildren(el: HTMLElement, ctx: SerializeCtx): string {
  if (ctx.list === 'ol') {
    let index = 0
    let out = ''
    for (const child of el.childNodes) {
      if (child instanceof HTMLElement && child.rawTagName.toLowerCase() === 'li') {
        index += 1
        out += markdownNode(child, { ...ctx, index })
      } else {
        out += markdownNode(child, ctx)
      }
    }
    return out
  }
  return el.childNodes.map((child) => markdownNode(child, ctx)).join('')
}

function markdownNode(node: Node, ctx: SerializeCtx): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    if (ctx.inPre) {
      return node.text
    }
    const collapsed = collapseText(node.text)
    if (collapsed.trim().length === 0) {
      return ctx.list !== null ? '' : collapsed
    }
    return collapsed
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return ''
  }

  if (shouldDropElement(node)) {
    return ''
  }

  const tag = node.rawTagName.toLowerCase()

  if (tag === 'img') {
    return imgFallback(node)
  }

  if (tag === 'br') {
    return '\n'
  }
  if (tag === 'hr') {
    return '\n\n---\n\n'
  }

  if (HEADING_TAGS.has(tag)) {
    const level = Number(tag.slice(1))
    const inner = markdownChildren(node, { ...ctx, list: null }).trim()
    if (inner.length === 0) {
      return ''
    }
    return `\n\n${'#'.repeat(level)} ${inner}\n\n`
  }

  if (tag === 'p' || tag === 'figcaption') {
    const inner = markdownChildren(node, { ...ctx, list: null }).trim()
    return inner.length === 0 ? '' : `\n\n${inner}\n\n`
  }

  if (tag === 'blockquote') {
    const inner = markdownChildren(node, { ...ctx, list: null }).trim()
    if (inner.length === 0) {
      return ''
    }
    const quoted = inner
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    return `\n\n${quoted}\n\n`
  }

  if (tag === 'pre') {
    const lang = languageClass(node) || languageClass(node.querySelector('code') ?? node)
    const inner = markdownChildren(node, { ...ctx, inPre: true, list: null }).replace(/\n$/, '')
    return `\n\n\`\`\`${lang}\n${inner}\n\`\`\`\n\n`
  }

  if (tag === 'code') {
    const inner = markdownChildren(node, { ...ctx, inPre: true, list: null })
    if (ctx.inPre) {
      return inner
    }
    return `\`${inner.replaceAll('`', '\\`')}\``
  }

  if (tag === 'ul' || tag === 'ol') {
    const inner = markdownChildren(node, { ...ctx, list: tag, index: 0 }).trimEnd()
    return inner.length === 0 ? '' : `\n\n${inner}\n\n`
  }

  if (tag === 'li') {
    const prefix = ctx.list === 'ol' ? `${ctx.index}. ` : '- '
    const inner = markdownChildren(node, { ...ctx, list: null }).trim()
    const indented = inner.replace(/\n/g, '\n  ')
    return `${prefix}${indented}\n`
  }

  if (tag === 'a') {
    const inner = markdownChildren(node, ctx).trim()
    const href = node.getAttribute('href')?.trim() ?? ''
    const resolved = href.length > 0 ? resolveHref(ctx.base, href) : null
    if (resolved === null || inner.length === 0) {
      return inner
    }
    return `[${inner}](${resolved})`
  }

  if (tag === 'strong' || tag === 'b') {
    const inner = markdownChildren(node, ctx).trim()
    return inner.length === 0 ? '' : `**${inner}**`
  }

  if (tag === 'em' || tag === 'i') {
    const inner = markdownChildren(node, ctx).trim()
    return inner.length === 0 ? '' : `*${inner}*`
  }

  if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr' || tag === 'th' || tag === 'td') {
    return htmlNode(node, ctx)
  }

  return markdownChildren(node, tag === 'code' || tag === 'pre' ? { ...ctx, inPre: true } : ctx)
}

function rootCtx(base: HttpUrl): SerializeCtx {
  return { base, inPre: false, list: null, index: 0 }
}

export function sanitizeContentHtml(root: HTMLElement, base: HttpUrl): string {
  return stripXmlIllegalChars(normalizeBlocks(htmlChildren(root, rootCtx(base))))
}

export function sanitizeFragmentHtml(html: string, base: HttpUrl): string {
  const root = parse(stripXmlIllegalChars(html), PARSE_HTML_OPTIONS)
  return sanitizeContentHtml(root, base)
}

export function htmlToMarkdown(html: string, base: HttpUrl): string {
  const root = parse(stripXmlIllegalChars(html), PARSE_HTML_OPTIONS)
  return stripXmlIllegalChars(normalizeBlocks(markdownChildren(root, rootCtx(base))))
}

const SLOT_OPEN = '\uE000'
const SLOT_CLOSE = '\uE001'

function stashHtml(slots: string[], html: string): string {
  const index = slots.length
  slots.push(html)
  return `${SLOT_OPEN}${index}${SLOT_CLOSE}`
}

function hrefFromHtmlAttrs(attrs: string): string {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
}

function residualAnchorHtml(attrs: string, inner: string, base: HttpUrl): string {
  const label = inner.replace(/<[^>]+>/g, '').trim()
  const href = hrefFromHtmlAttrs(attrs)
  const resolved = href.length > 0 ? resolveHref(base, href) : null
  if (resolved === null || label.length === 0) {
    return escapeText(label)
  }
  return `<a href="${escapeAttr(resolved)}">${escapeText(label)}</a>`
}

function inlineMarkdown(text: string, base: HttpUrl): string {
  const slots: string[] = []
  let current = text
  current = current.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_all, alt: string) => {
    const altText = imgAltText(alt)
    return altText.length > 0 ? stashHtml(slots, escapeText(altText)) : stashHtml(slots, '')
  })
  current = current.replace(/`([^`]+)`/g, (_all, code: string) => {
    return stashHtml(slots, `<code>${escapeText(code.replaceAll('\\`', '`'))}</code>`)
  })
  current = current.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_all, attrs: string, inner: string) => {
    return stashHtml(slots, residualAnchorHtml(attrs, inner, base))
  })
  current = current.replace(/<\/?a\b[^>]*>/gi, '')
  current = current.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_all, label: string, href: string) => {
    const resolved = resolveHref(base, href.trim())
    if (resolved === null) {
      return stashHtml(slots, escapeText(label))
    }
    return stashHtml(slots, `<a href="${escapeAttr(resolved)}">${escapeText(label)}</a>`)
  })
  current = current.replace(/\*\*([^*]+)\*\*/g, (_all, inner: string) => {
    return stashHtml(slots, `<strong>${escapeText(inner)}</strong>`)
  })
  current = current.replace(/\*([^*]+)\*/g, (_all, inner: string) => {
    return stashHtml(slots, `<em>${escapeText(inner)}</em>`)
  })
  return escapeText(current).replace(/\uE000(\d+)\uE001/g, (_all, index: string) => {
    return slots[Number(index)] ?? ''
  })
}

function isFenceOpen(line: string): string | null {
  const match = /^```([A-Za-z0-9_+-]*)\s*$/.exec(line)
  return match === null ? null : (match[1] ?? '')
}

function isFenceClose(line: string): boolean {
  return /^```\s*$/.test(line)
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (!trimmed.includes('|')) {
    return []
  }
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1)
  }
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) {
    trimmed = trimmed.slice(0, -1)
  }
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function isPipeTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line)
  if (cells.length === 0) {
    return false
  }
  return cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, '')))
}

function isPipeTableRow(line: string): boolean {
  return splitTableRow(line).length > 0 && !isPipeTableDelimiter(line)
}

function isPipeTableStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ''
  const next = lines[index + 1] ?? ''
  return isPipeTableRow(line) && isPipeTableDelimiter(next)
}

function isTableContinueRow(line: string): boolean {
  if (line.trim() === '' || isFenceOpen(line) !== null) {
    return false
  }
  if (/^(#{1,6})\s+\S/.test(line) || /^---+$/.test(line.trim()) || line.startsWith('<table')) {
    return false
  }
  if (/^>\s?/.test(line) || /^\s{0,3}[-*]\s+\S/.test(line) || /^\s{0,3}\d+\.\s+\S/.test(line)) {
    return false
  }
  return isPipeTableRow(line)
}

function pipeTableHtml(header: readonly string[], rows: readonly string[][], base: HttpUrl): string {
  const columns = header.length
  if (columns === 0) {
    return ''
  }
  const th = header.map((cell) => `<th>${inlineMarkdown(cell, base)}</th>`).join('')
  const body = rows
    .map((row) => {
      const cells = Array.from({ length: columns }, (_, index) => row[index] ?? '')
      const tds = cells.map((cell) => `<td>${inlineMarkdown(cell, base)}</td>`).join('')
      return `<tr>${tds}</tr>`
    })
    .join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ''
  return (
    isFenceOpen(line) !== null ||
    /^(#{1,6})\s+\S/.test(line) ||
    /^---+$/.test(line.trim()) ||
    line.startsWith('<table') ||
    isPipeTableStart(lines, index) ||
    /^>\s?/.test(line) ||
    /^\s{0,3}[-*]\s+\S/.test(line) ||
    /^\s{0,3}\d+\.\s+\S/.test(line)
  )
}

export function markdownToHtml(markdown: string, base: HttpUrl): string {
  const lines = stripXmlIllegalChars(stripChartTickMarkdown(stripPageCliWarnings(markdown)))
    .replaceAll('\r\n', '\n')
    .split('\n')
  const blocks: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fenceLang = isFenceOpen(line)
    if (fenceLang !== null) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !isFenceClose(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      const classAttr = fenceLang.length > 0 ? ` class="language-${escapeAttr(fenceLang)}"` : ''
      blocks.push(`<pre><code${classAttr}>${escapeText(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      const level = heading[1].length
      blocks.push(`<h${level}>${inlineMarkdown(heading[2].trim(), base)}</h${level}>`)
      index += 1
      continue
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push('<hr>')
      index += 1
      continue
    }

    if (line.startsWith('<table')) {
      const raw = [line]
      index += 1
      while (index < lines.length && !raw.join('\n').includes('</table>')) {
        raw.push(lines[index] ?? '')
        index += 1
      }
      const table = sanitizeFragmentHtml(raw.join('\n'), base)
      if (table.length > 0) {
        blocks.push(table)
      }
      continue
    }

    if (isPipeTableStart(lines, index)) {
      const header = splitTableRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && isTableContinueRow(lines[index] ?? '')) {
        rows.push(splitTableRow(lines[index] ?? ''))
        index += 1
      }
      const table = pipeTableHtml(header, rows, base)
      if (table.length > 0) {
        blocks.push(table)
      }
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/, ''))
        index += 1
      }
      const inner = markdownToHtml(quoted.join('\n'), base)
      if (inner.length > 0) {
        blocks.push(`<blockquote>${inner}</blockquote>`)
      }
      continue
    }

    const unordered = /^\s{0,3}[-*]\s+\S/.test(line)
    const ordered = /^\s{0,3}\d+\.\s+\S/.test(line)
    if (unordered || ordered) {
      const itemRe = ordered ? /^\s{0,3}\d+\.\s+(.*)$/ : /^\s{0,3}[-*]\s+(.*)$/
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const item = itemRe.exec(current)
        if (item?.[1] !== undefined) {
          items.push(item[1])
          index += 1
          continue
        }
        if (/^\s{2,}\S/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`
          index += 1
          continue
        }
        break
      }
      const tag = ordered ? 'ol' : 'ul'
      const lis = items.map((item) => `<li>${inlineMarkdown(item, base)}</li>`).join('')
      blocks.push(`<${tag}>${lis}</${tag}>`)
      continue
    }

    const para: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '' || startsBlock(lines, index)) {
        break
      }
      para.push(current.trim())
      index += 1
    }
    if (para.length > 0) {
      blocks.push(`<p>${inlineMarkdown(para.join(' '), base)}</p>`)
    }
  }

  return stripXmlIllegalChars(blocks.join(''))
}

export function visibleTextLength(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
}
