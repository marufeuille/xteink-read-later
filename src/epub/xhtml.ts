import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser'
import { PARSE_HTML_OPTIONS } from '../extract/constants'
import { imgAltText, stripXmlIllegalChars } from '../extract/xml-text'

const VOID_TAGS = new Set(['br', 'hr', 'meta', 'link', 'input'])

export function xmlEscape(value: string): string {
  return stripXmlIllegalChars(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function serialize(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return xmlEscape(node.text)
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE || !(node instanceof HTMLElement)) {
    return ''
  }
  const tag = node.rawTagName.toLowerCase()
  if (tag === 'img') {
    const alt = imgAltText(node.getAttribute('alt') ?? '')
    return alt.length > 0 ? xmlEscape(alt) : ''
  }
  const attrs = Object.entries(node.attributes)
    .map(([key, val]) => ` ${key}="${xmlEscape(val)}"`)
    .join('')
  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrs}/>`
  }
  const inner = node.childNodes.map(serialize).join('')
  return `<${tag}${attrs}>${inner}</${tag}>`
}

export function htmlFragmentToXhtml(fragment: string): string {
  const cleaned = stripXmlIllegalChars(fragment)
  const root = parse(`<div id="epub-root">${cleaned}</div>`, PARSE_HTML_OPTIONS)
  const wrapper = root.querySelector('#epub-root')
  if (wrapper === null) {
    return ''
  }
  return stripXmlIllegalChars(wrapper.childNodes.map(serialize).join(''))
}
