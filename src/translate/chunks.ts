import { x3ImageFromLine } from '../images/x3-token'

/**
 * Split source Markdown into pieces that each fit in one OpenAI call.
 * Block detection follows markdownToHtml: fences, tables, images, lists,
 * and quotes stay intact. A piece may exceed maxChars only when splitting
 * it would break one of those blocks or a single list item / line.
 */
export function splitMarkdownForTranslation(markdown: string, maxChars: number): readonly string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1 || markdown.length <= maxChars) {
    return [markdown]
  }
  const blocks = atomicBlocks(markdown).flatMap((block) => splitOversized(block, maxChars))
  const chunks = packBlocks(blocks, maxChars)
  return chunks.length === 0 ? [markdown] : chunks
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line)
}

function isHr(line: string): boolean {
  return /^---+$/.test(line.trim())
}

function isFenceOpen(line: string): boolean {
  return /^```[A-Za-z0-9_+-]*\s*$/.test(line)
}

function isFenceClose(line: string): boolean {
  return /^```\s*$/.test(line)
}

function isListItem(line: string): boolean {
  return /^\s{0,3}(?:[-*]|\d+\.)\s+\S/.test(line)
}

function isQuote(line: string): boolean {
  return /^>\s?/.test(line)
}

function isHtmlTableLine(line: string): boolean {
  return line.trimStart().startsWith('<table')
}

function isPipeDelimiter(line: string): boolean {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (!line.includes('|')) {
    return false
  }
  const cells = trimmed.split('|')
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
}

function isPipeRow(line: string): boolean {
  return line.includes('|') && !isPipeDelimiter(line)
}

function isPipeTableStart(lines: readonly string[], index: number): boolean {
  return isPipeRow(lines[index] ?? '') && isPipeDelimiter(lines[index + 1] ?? '')
}

function isTableContinue(line: string): boolean {
  if (
    isBlank(line) ||
    isFenceOpen(line) ||
    x3ImageFromLine(line) !== null ||
    isHeading(line) ||
    isHr(line) ||
    isHtmlTableLine(line) ||
    isQuote(line) ||
    isListItem(line)
  ) {
    return false
  }
  return isPipeRow(line)
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ''
  return (
    x3ImageFromLine(line) !== null ||
    isFenceOpen(line) ||
    isHeading(line) ||
    isHr(line) ||
    isHtmlTableLine(line) ||
    isPipeTableStart(lines, index) ||
    isQuote(line) ||
    isListItem(line)
  )
}

function atomicBlocks(markdown: string): string[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const blocks: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (isBlank(line)) {
      index += 1
      continue
    }
    if (x3ImageFromLine(line) !== null) {
      blocks.push(line.trim())
      index += 1
      continue
    }
    if (isFenceOpen(line)) {
      const start = index
      index += 1
      while (index < lines.length && !isFenceClose(lines[index] ?? '')) {
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      blocks.push(lines.slice(start, index).join('\n'))
      continue
    }
    if (isHeading(line) || isHr(line)) {
      blocks.push(line.trim())
      index += 1
      continue
    }
    if (isHtmlTableLine(line)) {
      const start = index
      let joined = line
      index += 1
      while (index < lines.length && !joined.includes('</table>')) {
        joined = `${joined}\n${lines[index] ?? ''}`
        index += 1
      }
      blocks.push(lines.slice(start, index).join('\n').trim())
      continue
    }
    if (isPipeTableStart(lines, index)) {
      const start = index
      index += 2
      while (index < lines.length && isTableContinue(lines[index] ?? '')) {
        index += 1
      }
      blocks.push(lines.slice(start, index).join('\n'))
      continue
    }
    if (isQuote(line)) {
      const start = index
      while (index < lines.length && isQuote(lines[index] ?? '')) {
        index += 1
      }
      blocks.push(lines.slice(start, index).join('\n'))
      continue
    }
    if (isListItem(line)) {
      const start = index
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (x3ImageFromLine(current) !== null) {
          break
        }
        if (isListItem(current) || (index > start && /^\s{2,}\S/.test(current))) {
          index += 1
          continue
        }
        break
      }
      blocks.push(lines.slice(start, index).join('\n').replace(/\n+$/, ''))
      continue
    }
    const start = index
    while (index < lines.length && !isBlank(lines[index] ?? '') && !startsBlock(lines, index)) {
      index += 1
    }
    if (index === start) {
      blocks.push(line)
      index += 1
      continue
    }
    const text = lines.slice(start, index).join('\n').trim()
    if (text.length > 0) {
      blocks.push(text)
    }
  }
  return blocks
}

function unsplittable(block: string): boolean {
  const lines = block.split('\n')
  const first = lines[0] ?? ''
  return (
    x3ImageFromLine(first) !== null ||
    isFenceOpen(first) ||
    isHeading(first) ||
    isHr(first) ||
    isHtmlTableLine(first) ||
    isPipeTableStart(lines, 0)
  )
}

function listItems(block: string): string[] {
  const items: string[] = []
  let current: string[] = []
  for (const line of block.split('\n')) {
    if (isListItem(line) && current.length > 0) {
      items.push(current.join('\n'))
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length > 0) {
    items.push(current.join('\n'))
  }
  return items
}

function isListBlock(block: string): boolean {
  const lines = block.split('\n')
  if (!isListItem(lines[0] ?? '')) {
    return false
  }
  return lines.every(
    (line, index) => isListItem(line) || (index > 0 && /^\s{2,}\S/.test(line)),
  )
}

function isQuoteBlock(block: string): boolean {
  const lines = block.split('\n')
  return lines.length > 0 && lines.every((line) => isQuote(line))
}

function packPieces(pieces: readonly string[], maxChars: number, separator: string): string[] {
  const packed: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (piece.length === 0) {
      continue
    }
    if (current.length === 0) {
      current = piece
      continue
    }
    const next = `${current}${separator}${piece}`
    if (next.length > maxChars) {
      packed.push(current)
      current = piece
      continue
    }
    current = next
  }
  if (current.length > 0) {
    packed.push(current)
  }
  return packed
}

function hardSplit(text: string, maxChars: number): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars)
    if (cut < Math.floor(maxChars / 2)) {
      cut = maxChars
    }
    const piece = rest.slice(0, cut).trim()
    if (piece.length === 0) {
      parts.push(rest.slice(0, maxChars))
      rest = rest.slice(maxChars).trim()
      continue
    }
    parts.push(piece)
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) {
    parts.push(rest)
  }
  return parts
}

function splitProse(text: string, maxChars: number): string[] {
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter((sentence) => sentence.length > 0)
  return packPieces(sentences, maxChars, ' ').flatMap((piece) =>
    piece.length <= maxChars ? [piece] : hardSplit(piece, maxChars),
  )
}

function splitOversized(block: string, maxChars: number): string[] {
  if (block.length <= maxChars || unsplittable(block)) {
    return [block]
  }
  if (isListBlock(block)) {
    return packPieces(listItems(block), maxChars, '\n')
  }
  if (isQuoteBlock(block)) {
    return packPieces(block.split('\n'), maxChars, '\n')
  }
  return splitProse(block, maxChars)
}

function packBlocks(blocks: readonly string[], maxChars: number): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let size = 0

  const flush = (): void => {
    if (current.length === 0) {
      return
    }
    chunks.push(current.join('\n\n'))
    current = []
    size = 0
  }

  const push = (block: string): void => {
    size = current.length === 0 ? block.length : size + 2 + block.length
    current.push(block)
  }

  for (const block of blocks) {
    const nextSize = current.length === 0 ? block.length : size + 2 + block.length
    if (current.length > 0 && nextSize > maxChars) {
      const last = current[current.length - 1]
      if (last !== undefined && current.length > 1 && isHeading(last)) {
        current.pop()
        size -= 2 + last.length
        flush()
        push(last)
      } else {
        flush()
      }
      const withCarried = current.length === 0 ? block.length : size + 2 + block.length
      if (current.length > 0 && withCarried > maxChars) {
        flush()
      }
    }
    push(block)
  }
  flush()
  return chunks
}
