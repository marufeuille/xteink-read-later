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

  it('strips chart axis tick lists from reading body and keeps real steps', () => {
    const xhtml = htmlFragmentToXhtml(
      '<p>Dummy charts body.</p><ol aria-hidden="true"><li>&lt;</li><li>2</li><li>0</li><li>12</li><li>01234567890123456</li></ol><ol><li>Enable nodejs_compat</li></ol>',
    )
    expect(xhtml).toContain('Dummy charts body.')
    expect(xhtml).toContain('Enable nodejs_compat')
    expect(xhtml).not.toContain('01234567890123456')
    expect(xhtml).not.toContain('&lt;')
  })

  it('strips page CLI warn tokens from reading body and keeps dct render', () => {
    const xhtml = htmlFragmentToXhtml(
      '<p>Dummy charts body.</p><pre><code>dct render\nWARN-BAR-BAND-WIDTH-TOO-NARROW\nWARN-TABLE-COLUMNS-OVERFLOW\n</code></pre>',
    )
    expect(xhtml).toContain('dct render')
    expect(xhtml).not.toContain('WARN-BAR-BAND-WIDTH-TOO-NARROW')
    expect(xhtml).not.toContain('WARN-TABLE-COLUMNS-OVERFLOW')
  })

  it('strips Sign in / Join Waitlist menu chrome from reading body', () => {
    const xhtml = htmlFragmentToXhtml(
      '<div class="toolbar">' +
        '<a href="/manifesto">Manifesto</a>' +
        '<a href="/team">Our Team</a>' +
        '<a href="/docs">Docs</a>' +
        '<a href="/signin">Sign in</a>' +
        '<a href="/waitlist">Join Waitlist</a>' +
        '</div>' +
        '<p>Dummy System One body about nodejs_compat.</p>',
    )
    expect(xhtml).toContain('nodejs_compat')
    expect(xhtml).not.toContain('Sign in')
    expect(xhtml).not.toContain('Join Waitlist')
    expect(xhtml).not.toContain('Manifesto')
  })
})
