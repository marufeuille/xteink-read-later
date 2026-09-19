import { describe, expect, it } from 'vitest'
import { htmlFragmentToXhtml, xmlEscape } from '../src/epub/xhtml'

describe('xmlEscape', () => {
  it('escapes XML entities and strips illegal C0', () => {
    expect(xmlEscape(`A&B<"'>`)).toBe('A&amp;B&lt;&quot;&apos;&gt;')
    expect(xmlEscape('nul\u0000bell\u0007')).toBe('nulbell')
  })
})

describe('htmlFragmentToXhtml', () => {
  it('self-closes void tags and serializes nesting', () => {
    expect(htmlFragmentToXhtml('<p>line<br>break</p><hr>')).toBe('<p>line<br/>break</p><hr/>')
  })

  it('drops img tags, keeps short alt, and strips NUL', () => {
    const xhtml = htmlFragmentToXhtml(
      '<p>Dummy\u0000 body.</p><p><img src="https://example.com/chart.svg" alt="SVG chart caption"></p>',
    )
    expect(xhtml).not.toContain('\u0000')
    expect(xhtml).not.toMatch(/<img\b/i)
    expect(xhtml).toContain('Dummy body.')
    expect(xhtml).toContain('SVG chart caption')
    expect(xhtml).not.toContain('example.com/chart.svg')
  })
})
