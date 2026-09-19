import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser'

const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input'])

export function xmlEscape(value: string): string {
  return value
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
  const root = parse(`<div id="epub-root">${fragment}</div>`)
  const wrapper = root.querySelector('#epub-root')
  if (wrapper === null) {
    return ''
  }
  return wrapper.childNodes.map(serialize).join('')
}
