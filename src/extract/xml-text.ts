const XML_ILLEGAL_C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g
const IMG_ALT_MAX = 200
const CHART_TICK_TOKEN = /^[<\uFF1C>=+\-−–—.,°%0-9\s]+$/
const ORDERED_ITEM = /^\s{0,3}\d+\.\s+(.*)$/
const UNORDERED_ITEM = /^\s{0,3}[-*]\s+(.*)$/

export function stripXmlIllegalChars(value: string): string {
  return value.replace(XML_ILLEGAL_C0, '')
}

export function isChartTickToken(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim()
  const compact = text.replace(/\s+/g, '')
  if (compact.length === 0 || compact.length > 24) {
    return false
  }
  return CHART_TICK_TOKEN.test(text)
}

export function isChartTickItemList(items: readonly string[]): boolean {
  if (items.length < 3 || !items.every(isChartTickToken)) {
    return false
  }
  const hasAxisMark = items.some((item) => /[<\uFF1C>]/.test(item) || /[0-9]{8,}/.test(item.replace(/\s+/g, '')))
  const shortDigits = items.length >= 4 && items.every((item) => item.replace(/\s+/g, '').length <= 2)
  return hasAxisMark || shortDigits
}

export function isLoneChartTick(value: string): boolean {
  const compact = value.replace(/\s+/g, '').trim()
  if (compact === '<' || compact === '\uFF1C' || compact === '>' || compact === '<>') {
    return true
  }
  return /^[0-9]{8,}$/.test(compact)
}

export function stripPageCliWarnings(value: string): string {
  return value
    .split('\n')
    .flatMap((line) => {
      const stripped = line.replace(/WARN-BAR-BAND-WIDTH-TOO-NARROW|WARN-TABLE-COLUMNS-OVERFLOW/g, '')
      if (stripped === line) {
        return [line]
      }
      return stripped.trim().length === 0 ? [] : [stripped.replace(/[ \t]+$/g, '')]
    })
    .join('\n')
}

function markdownListItem(line: string): string | null {
  return ORDERED_ITEM.exec(line)?.[1] ?? UNORDERED_ITEM.exec(line)?.[1] ?? null
}

export function stripChartTickMarkdown(value: string): string {
  const lines = value.replaceAll('\r\n', '\n').split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const first = markdownListItem(lines[index] ?? '')
    if (first !== null) {
      const items: string[] = []
      let cursor = index
      while (cursor < lines.length) {
        const item = markdownListItem(lines[cursor] ?? '')
        if (item === null) {
          break
        }
        items.push(item)
        cursor += 1
      }
      if (isChartTickItemList(items)) {
        index = cursor
        continue
      }
    }
    const line = lines[index] ?? ''
    if (isLoneChartTick(line)) {
      index += 1
      continue
    }
    out.push(line)
    index += 1
  }
  return out.join('\n')
}

export function imgAltText(alt: string): string {
  const collapsed = alt.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= IMG_ALT_MAX) {
    return collapsed
  }
  return collapsed.slice(0, IMG_ALT_MAX)
}
