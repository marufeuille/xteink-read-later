import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser'
import { PARSE_HTML_OPTIONS } from '../extract/constants'
import { isAriaHidden, isChartTickList, isLinkChrome, isSoloNavChrome, isChromePhraseText } from '../extract/sanitize-html'
import {
  imgAltText,
  isLoneChartTick,
  stripChartTickMarkdown,
  stripPageCliWarnings,
  stripXmlIllegalChars,
} from '../extract/xml-text'

const VOID_TAGS = new Set(['br', 'hr', 'meta', 'link', 'input'])

export type XhtmlOptions = {
  readonly preserveImageSrcs?: ReadonlySet<string>
}

export function xmlEscape(value: string): string {
  return stripXmlIllegalChars(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function preservedImage(node: HTMLElement, options: XhtmlOptions): string | null {
  const src = node.getAttribute('src') ?? ''
  if (options.preserveImageSrcs?.has(src) !== true) {
    return null
  }
  const alt = node.getAttribute('alt') ?? ''
  return `<img class="digest-qr" src="${xmlEscape(src)}" alt="${xmlEscape(alt)}"/>`
}

function serialize(node: Node, options: XhtmlOptions): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return isLoneChartTick(node.text) ? '' : xmlEscape(node.text)
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return ''
  }
  if (isAriaHidden(node) || isChartTickList(node) || isLinkChrome(node) || isSoloNavChrome(node)) {
    return ''
  }
  const tag = node.rawTagName.toLowerCase()
  if (tag === 'img') {
    const preserved = preservedImage(node, options)
    if (preserved !== null) {
      return preserved
    }
    const alt = imgAltText(node.getAttribute('alt') ?? '')
    return alt.length > 0 ? xmlEscape(alt) : ''
  }
  if ((tag === 'p' || tag === 'li') && isLoneChartTick(node.text)) {
    return ''
  }
  if ((tag === 'p' || tag === 'div') && isChromePhraseText(node.text.replace(/\s+/g, ' ').trim())) {
    return ''
  }
  const attrs = Object.entries(node.attributes)
    .map(([key, val]) => ` ${key}="${xmlEscape(val)}"`)
    .join('')
  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrs}/>`
  }
  const inner = node.childNodes.map((child) => serialize(child, options)).join('')
  if (
    inner.replace(/<[^>]+>/g, '').trim().length === 0 &&
    !/<img\b/i.test(inner) &&
    (tag === 'figure' || tag === 'figcaption' || tag === 'ul' || tag === 'ol' || tag === 'p')
  ) {
    return ''
  }
  return `<${tag}${attrs}>${inner}</${tag}>`
}

export function htmlFragmentToXhtml(fragment: string, options: XhtmlOptions = {}): string {
  const cleaned = stripXmlIllegalChars(stripChartTickMarkdown(stripPageCliWarnings(fragment)))
  const root = parse(`<div id="epub-root">${cleaned}</div>`, PARSE_HTML_OPTIONS)
  const wrapper = root.querySelector('#epub-root')
  if (wrapper === null) {
    return ''
  }
  return stripXmlIllegalChars(wrapper.childNodes.map((child) => serialize(child, options)).join(''))
}
