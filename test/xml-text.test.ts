import { describe, expect, it } from 'vitest'
import { imgAltText, stripPageCliWarnings, stripXmlIllegalChars } from '../src/extract/xml-text'

describe('stripXmlIllegalChars', () => {
  it('drops XML 1.0 illegal C0 while keeping tab, LF, and CR', () => {
    expect(stripXmlIllegalChars('A\u0000B\u0007C\u000BD\u000CE\u001FF')).toBe('ABCDEF')
    expect(stripXmlIllegalChars('keep\ttab\nand\rCR')).toBe('keep\ttab\nand\rCR')
  })
})

describe('imgAltText', () => {
  it('collapses whitespace and caps length at 200', () => {
    expect(imgAltText('  SVG   chart  ')).toBe('SVG chart')
    expect(imgAltText('')).toBe('')
    const long = 'x'.repeat(201)
    expect(imgAltText(long)).toBe('x'.repeat(200))
  })
})

describe('stripPageCliWarnings', () => {
  it('drops page CLI warn tokens and keeps real commands', () => {
    const input = [
      'dct render',
      'WARN-BAR-BAND-WIDTH-TOO-NARROW',
      'WARN-TABLE-COLUMNS-OVERFLOW',
      'dct render --check',
    ].join('\n')
    const stripped = stripPageCliWarnings(input)
    expect(stripped).toContain('dct render')
    expect(stripped).toContain('dct render --check')
    expect(stripped).not.toContain('WARN-BAR-BAND-WIDTH-TOO-NARROW')
    expect(stripped).not.toContain('WARN-TABLE-COLUMNS-OVERFLOW')
  })
})
