import { describe, expect, it } from 'vitest'
import {
  imgAltText,
  isChartTickItemList,
  isChartTickToken,
  isLoneChartTick,
  stripChartTickMarkdown,
  stripPageCliWarnings,
  stripXmlIllegalChars,
} from '../src/extract/xml-text'

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

describe('chart tick tokens', () => {
  it('detects axis ticks and leftover markup, not real list copy', () => {
    expect(isChartTickToken('<')).toBe(true)
    expect(isChartTickToken('12')).toBe(true)
    expect(isChartTickToken('01234567890123456')).toBe(true)
    expect(isChartTickToken('Enable nodejs_compat')).toBe(false)
    expect(isLoneChartTick('<')).toBe(true)
    expect(isLoneChartTick('01234567890123456')).toBe(true)
    expect(isLoneChartTick('2026')).toBe(false)
    expect(isChartTickItemList(['<', '2', '0', '12', '01234567890123456'])).toBe(true)
    expect(isChartTickItemList(['80', '90', '100'])).toBe(false)
    expect(isChartTickItemList(['Enable nodejs_compat', 'Keep compatibility_date current', 'Set cpu_ms'])).toBe(
      false,
    )
  })

  it('strips numbered tick lists from Markdown and keeps real steps', () => {
    const stripped = stripChartTickMarkdown(
      [
        'Dummy charts body.',
        '',
        '1. <',
        '2. 2',
        '3. 0',
        '4. 12',
        '5. 01234567890123456',
        '',
        '1. Enable nodejs_compat',
        '2. Keep compatibility_date current',
      ].join('\n'),
    )
    expect(stripped).toContain('Dummy charts body.')
    expect(stripped).toContain('Enable nodejs_compat')
    expect(stripped).toContain('Keep compatibility_date current')
    expect(stripped).not.toContain('1. <')
    expect(stripped).not.toContain('01234567890123456')
  })
})
