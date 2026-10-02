import { describe, expect, it } from 'vitest'
import { x3ImageMarker } from '../src/images/x3-token'
import { splitMarkdownForTranslation } from '../src/translate/chunks'
import { TRANSLATE_CHUNK_MAX_CHARS } from '../src/translate/constants'

describe('splitMarkdownForTranslation', () => {
  it('returns the original markdown when it fits in one call', () => {
    const markdown = '# Title\n\nOne short paragraph.'
    expect(splitMarkdownForTranslation(markdown, TRANSLATE_CHUNK_MAX_CHARS)).toEqual([markdown])
  })

  it('splits a Substack-scale article into pieces that each fit in one 60s call', () => {
    const sentence = 'Review every generated line before it ships. '
    const source = sentence.repeat(Math.ceil(27_000 / sentence.length))
    expect(source.length).toBeGreaterThanOrEqual(27_000)
    const chunks = splitMarkdownForTranslation(source, TRANSLATE_CHUNK_MAX_CHARS)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TRANSLATE_CHUNK_MAX_CHARS)
    }
    expect(chunks.join('\n\n').replaceAll('\n\n', ' ').trim()).toBe(source.trim())
  })

  it('keeps a fenced block with a blank line inside one chunk', () => {
    const fence = '```ts\nconst KEEP = 1\n\nconst STILL = 2\n```'
    const markdown = `${'a'.repeat(50)}\n\n${fence}\n\n${'b'.repeat(50)}`
    const chunks = splitMarkdownForTranslation(markdown, 80)
    const holders = chunks.filter((chunk) => chunk.includes('KEEP'))
    expect(holders).toEqual([fence])
    expect(chunks.some((chunk) => chunk.includes('STILL') && !chunk.includes('```'))).toBe(false)
  })

  it('keeps an image placeholder on its own line inside one chunk', () => {
    const marker = x3ImageMarker(1, 'https://example.com/diagram.png')
    const markdown = `${'a'.repeat(50)}\n\n${marker}\n\n${'b'.repeat(50)}`
    const chunks = splitMarkdownForTranslation(markdown, 80)
    expect(chunks.filter((chunk) => chunk.includes('X3IMG:'))).toEqual([marker])
    expect(marker.endsWith('|')).toBe(true)
  })

  it('keeps a pipe table together', () => {
    const table = '| name | value |\n| --- | --- |\n| compatibility_date | 2026-09-19 |'
    const markdown = `${'a'.repeat(40)}\n\n${table}\n\n${'b'.repeat(40)}`
    const chunks = splitMarkdownForTranslation(markdown, 70)
    expect(chunks.filter((chunk) => chunk.includes('compatibility_date'))).toEqual([table])
  })

  it('does not swallow a heading that follows a pipe table', () => {
    const markdown = '| a | b |\n| --- | --- |\n| 1 | 2 |\n# Next\n\nAfter the table.'
    const chunks = splitMarkdownForTranslation(markdown, 40)
    expect(chunks.some((chunk) => chunk.includes('| 1 | 2 |') && chunk.includes('# Next'))).toBe(false)
    expect(chunks.some((chunk) => chunk.startsWith('# Next'))).toBe(true)
  })

  it('keeps an HTML table together', () => {
    const table = '<table><thead><tr><th>name</th></tr></thead><tbody><tr><td>workers</td></tr></tbody></table>'
    const markdown = `Intro paragraph.\n\n${table}\n\nOutro paragraph.`
    const chunks = splitMarkdownForTranslation(markdown, 40)
    expect(chunks.filter((chunk) => chunk.includes('<table'))).toEqual([table])
    expect(chunks.some((chunk) => chunk.includes('</table>') && !chunk.includes('<table'))).toBe(false)
  })

  it('carries a heading into the next chunk instead of leaving it behind', () => {
    const markdown = `# Title\n\n${'a'.repeat(80)}\n\n# Next\n\n${'b'.repeat(80)}`
    const chunks = splitMarkdownForTranslation(markdown, 90)
    expect(chunks[0]?.endsWith('# Next')).toBe(false)
    expect(chunks.some((chunk) => chunk.startsWith('# Next'))).toBe(true)
    expect(chunks.find((chunk) => chunk.startsWith('# Next'))).toContain('b'.repeat(80))
  })

  it('splits a long list between items', () => {
    const items = Array.from({ length: 10 }, (_, index) => `- item ${index} ${'x'.repeat(20)}`)
    const chunks = splitMarkdownForTranslation(items.join('\n'), 80)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80)
      expect(chunk.startsWith('- item ')).toBe(true)
    }
    expect(chunks.join('\n')).toBe(items.join('\n'))
  })

  it('leaves an oversized code fence as one chunk', () => {
    const fence = `\`\`\`\n${'const x = 1\n'.repeat(30)}\`\`\``
    expect(fence.length).toBeGreaterThan(80)
    expect(splitMarkdownForTranslation(`before\n\n${fence}\n\nafter`, 80)).toContain(fence)
  })

  it('returns the original markdown when maxChars is not a positive integer', () => {
    const markdown = 'paragraph'
    expect(splitMarkdownForTranslation(markdown, 0)).toEqual([markdown])
  })
})
