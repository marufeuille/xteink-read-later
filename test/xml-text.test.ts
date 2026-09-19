import { describe, expect, it } from 'vitest'
import { imgAltText, stripXmlIllegalChars } from '../src/extract/xml-text'

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
