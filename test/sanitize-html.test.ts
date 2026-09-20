import { describe, expect, it } from 'vitest'
import {
  htmlToMarkdown,
  markdownToHtml,
  sanitizeContentHtml,
} from '../src/extract/sanitize-html'
import { PARSE_HTML_OPTIONS } from '../src/extract/constants'
import { parse } from 'node-html-parser'
import { parseHttpUrl, type HttpUrl } from '../src/types'

function url(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

const BASE = url('https://example.com/posts/compat')

const SOUP = `
<script>window.ads="pay-for-this-banner";</script>
<style>.ad-slot{display:block}</style>
<nav role="navigation"><a href="/home">Home</a></nav>
<iframe src="https://ads.example/pixel"></iframe>
<svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"></path></svg>
<form action="/subscribe"><input name="email" value="x@example.com" /></form>
<div class="advertisement">Sponsored advertisement BUY NOW</div>
<aside class="sidebar">Related posts you may like</aside>
<article>
  <h1>Keep compatibility_date current</h1>
  <p>Set it in <a href="/docs/wrangler">wrangler.jsonc</a> so the Worker can use current APIs.</p>
  <ul>
    <li>Enable nodejs_compat</li>
    <li>Keep compatibility_date current</li>
  </ul>
  <pre><code class="language-json">{"compatibility_date":"2026-09-19"}</code></pre>
  <p>Node.js built-ins need the nodejs_compat compatibility flag.</p>
</article>
`

describe('htmlToMarkdown', () => {
  it('drops script, style, nav, iframe, svg, form, and ads-like chrome', () => {
    const markdown = htmlToMarkdown(SOUP, BASE)
    expect(markdown).not.toContain('window.ads')
    expect(markdown).not.toContain('pay-for-this-banner')
    expect(markdown).not.toContain('.ad-slot')
    expect(markdown).not.toContain('Home')
    expect(markdown).not.toContain('ads.example/pixel')
    expect(markdown).not.toContain('viewBox')
    expect(markdown).not.toContain('x@example.com')
    expect(markdown).not.toContain('Sponsored advertisement')
    expect(markdown).not.toContain('Related posts you may like')
    expect(markdown).not.toMatch(/<script|<style|<nav|<iframe|<svg|<form|<input|<aside/i)
  })

  it('keeps headings, paragraphs, lists, links, and pre/code as Markdown', () => {
    const markdown = htmlToMarkdown(SOUP, BASE)
    expect(markdown).toContain('# Keep compatibility_date current')
    expect(markdown).toContain('[wrangler.jsonc](https://example.com/docs/wrangler)')
    expect(markdown).toContain('- Enable nodejs_compat')
    expect(markdown).toMatch(/- Enable nodejs_compat\n- Keep compatibility_date current/)
    expect(markdown).toContain('```json')
    expect(markdown).toContain('{"compatibility_date":"2026-09-19"}')
    expect(markdown).toContain('nodejs_compat compatibility flag')
    expect(markdown).not.toContain('<h1>')
    expect(markdown).not.toContain('<p>')
    expect(markdown).not.toContain('<div')
  })

  it('does not unwrap script or style text into the document', () => {
    const markdown = htmlToMarkdown(
      '<p>Visible paragraph for the article body.</p><script>alert(1)</script><style>body{display:none}</style>',
      BASE,
    )
    expect(markdown).toContain('Visible paragraph for the article body.')
    expect(markdown).not.toContain('alert(1)')
    expect(markdown).not.toContain('display:none')
  })

  it('keeps highlighter comment tokens inside pre/code', () => {
    const markdown = htmlToMarkdown(
      '<pre><code><span class="hljs-comment">// Do not retry this non-idempotent operation.</span>\nsubmitPayment();\n<span class="token comment">// second highlighter comment token</span></code></pre>',
      BASE,
    )
    expect(markdown).toContain('Do not retry this non-idempotent operation.')
    expect(markdown).toContain('submitPayment();')
    expect(markdown).toContain('second highlighter comment token')
    expect(markdown).toContain('```')
    expect(markdown).not.toContain('class="token"')
  })

  it('is more compact than the original tag soup', () => {
    const markdown = htmlToMarkdown(SOUP, BASE)
    expect(markdown.length).toBeLessThan(SOUP.length / 2)
  })
})

describe('markdownToHtml', () => {
  it('turns Markdown back into HTML the EPUB builder can consume', () => {
    const markdown = htmlToMarkdown(SOUP, BASE)
    const html = markdownToHtml(markdown, BASE)
    expect(html).toContain('<h1>Keep compatibility_date current</h1>')
    expect(html).toContain('<a href="https://example.com/docs/wrangler">wrangler.jsonc</a>')
    expect(html).toContain('<li>Enable nodejs_compat</li>')
    expect(html).toContain('<pre><code class="language-json">{"compatibility_date":"2026-09-19"}</code></pre>')
    expect(html).not.toContain('window.ads')
  })
})

describe('sanitizeContentHtml', () => {
  it('still drops chrome from extract HTML used before Markdown conversion', () => {
    const html = sanitizeContentHtml(parse(SOUP, PARSE_HTML_OPTIONS), BASE)
    expect(html).not.toContain('window.ads')
    expect(html).toContain('<h1>Keep compatibility_date current</h1>')
    expect(html).toContain('{"compatibility_date":"2026-09-19"}')
  })
})

describe('XML-illegal chars and img drop', () => {
  const dummy =
    '<p>Intro\u0000 text</p>' +
    '<pre>Keep\ttabs and\nline feeds.</pre>' +
    '<p>Bell\u0007 gone.</p>' +
    '<p><img src="https://example.com/chart.svg" alt="SVG chart caption"></p>' +
    '<p><img src="https://example.com/photo.png" alt="PNG photo caption"></p>' +
    '<p><img src="data:image/png;base64,AAAA" alt="Data URI caption"></p>' +
    '<p><img src="https://example.com/no-alt.svg"></p>'

  it('strips NUL and other C0 from Markdown while keeping tab and LF', () => {
    const markdown = htmlToMarkdown(dummy, BASE)
    expect(markdown).not.toContain('\u0000')
    expect(markdown).not.toContain('\u0007')
    expect(markdown).toContain('\t')
    expect(markdown).toContain('\n')
    expect(markdown).toContain('Intro text')
    expect(markdown).toContain('Keep\ttabs and\nline feeds.')
  })

  it('drops svg, png, and data-URI img, keeping short alt text', () => {
    const markdown = htmlToMarkdown(dummy, BASE)
    expect(markdown).not.toMatch(/!\[/)
    expect(markdown).not.toContain('<img')
    expect(markdown).toContain('SVG chart caption')
    expect(markdown).toContain('PNG photo caption')
    expect(markdown).toContain('Data URI caption')
    expect(markdown).not.toContain('example.com/chart.svg')
    expect(markdown).not.toContain('example.com/photo.png')
    expect(markdown).not.toContain('data:image/png')
  })

  it('does not resurrect Markdown images as HTML img', () => {
    const html = markdownToHtml(
      'See ![SVG chart caption](https://example.com/chart.svg) and ![PNG photo caption](https://example.com/photo.png) and ![Data URI caption](data:image/png;base64,AAAA).',
      BASE,
    )
    expect(html).not.toMatch(/<img\b/i)
    expect(html).not.toContain('\u0000')
    expect(html).toContain('SVG chart caption')
    expect(html).toContain('PNG photo caption')
    expect(html).toContain('Data URI caption')
    expect(html).not.toContain('example.com/chart.svg')
  })

  it('strips C0 from markdownToHtml output', () => {
    const html = markdownToHtml('Hello\u0000 world\u0007.', BASE)
    expect(html).not.toContain('\u0000')
    expect(html).not.toContain('\u0007')
    expect(html).toContain('Hello world')
  })
})

describe('tables and nested lists', () => {
  it('round-trips a table through Markdown HTML passthrough', () => {
    const html =
      '<table><thead><tr><th>Flag</th><th>Meaning</th></tr></thead>' +
      '<tbody><tr><td>nodejs_compat</td><td>Node builtins</td></tr></tbody></table>'
    const markdown = htmlToMarkdown(html, BASE)
    expect(markdown).toContain('<table')
    expect(markdown).toContain('<th>Flag</th>')
    expect(markdown).toContain('<td>nodejs_compat</td>')
    const roundTrip = markdownToHtml(markdown, BASE)
    expect(roundTrip).toContain('<table')
    expect(roundTrip).toContain('<th>Flag</th>')
    expect(roundTrip).toContain('<td>Node builtins</td>')
  })

  it('turns GFM pipe tables into HTML tables with sanitized cell links', () => {
    const markdown = [
      '| Flag | Docs |',
      '| --- | --- |',
      '| nodejs_compat | [wrangler](https://example.com/docs/wrangler) |',
      '| cpu_ms | see <a href="https://example.com/docs/cpu">CPU limit</a> |',
    ].join('\n')
    const html = markdownToHtml(markdown, BASE)
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Flag</th>')
    expect(html).toContain('<th>Docs</th>')
    expect(html).toContain('<td>nodejs_compat</td>')
    expect(html).toContain('<a href="https://example.com/docs/wrangler">wrangler</a>')
    expect(html).toContain('<a href="https://example.com/docs/cpu">CPU limit</a>')
    expect(html).not.toContain('<p>|')
    expect(html).not.toContain('&lt;a')
    expect(html).not.toMatch(/<a(?![^>]*\bhref=)/)
  })

  it('does not treat a lone pipe line as a table', () => {
    const html = markdownToHtml('Use cpu_ms | nodejs_compat together.', BASE)
    expect(html).toBe('<p>Use cpu_ms | nodejs_compat together.</p>')
    expect(html).not.toContain('<table')
  })

  it('strips page CLI warn tokens from fenced code and keeps dct render', () => {
    const html = markdownToHtml(
      ['Dummy charts body.', '', '```', 'dct render', 'WARN-BAR-BAND-WIDTH-TOO-NARROW', 'WARN-TABLE-COLUMNS-OVERFLOW', '```'].join('\n'),
      BASE,
    )
    expect(html).toContain('dct render')
    expect(html).toContain('<pre><code>')
    expect(html).not.toContain('WARN-BAR-BAND-WIDTH-TOO-NARROW')
    expect(html).not.toContain('WARN-TABLE-COLUMNS-OVERFLOW')
  })

  it('strips chart axis tick lists and leftover markup from Markdown HTML', () => {
    const html = markdownToHtml(
      [
        'Dummy charts body about nodejs_compat.',
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
      BASE,
    )
    expect(html).toContain('Dummy charts body about nodejs_compat.')
    expect(html).toContain('<li>Enable nodejs_compat</li>')
    expect(html).not.toContain('01234567890123456')
    expect(html).not.toContain('<li>&lt;</li>')
    expect(html).not.toMatch(/<li>\s*12\s*<\/li>/)
  })

  it('drops aria-hidden and tick lists when converting HTML to Markdown', () => {
    const markdown = htmlToMarkdown(
      '<p>Dummy charts body about nodejs_compat.</p>' +
        '<ol aria-hidden="true"><li>&lt;</li><li>2</li><li>0</li><li>12</li><li>01234567890123456</li></ol>' +
        '<ol><li>Enable nodejs_compat</li><li>Keep compatibility_date current</li><li>Set cpu_ms on Paid</li></ol>',
      BASE,
    )
    expect(markdown).toContain('Dummy charts body about nodejs_compat.')
    expect(markdown).toContain('Enable nodejs_compat')
    expect(markdown).not.toContain('01234567890123456')
    expect(markdown).not.toMatch(/^1\. </m)
  })

  it('keeps nested list items through Markdown and back to HTML', () => {
    const html =
      '<ul><li>Parent item<ul><li>Nested child</li><li>Second child</li></ul></li><li>Sibling</li></ul>'
    const markdown = htmlToMarkdown(html, BASE)
    expect(markdown).toContain('Parent item')
    expect(markdown).toContain('Nested child')
    expect(markdown).toContain('Second child')
    expect(markdown).toContain('Sibling')
    const roundTrip = markdownToHtml(markdown, BASE)
    expect(roundTrip).toContain('<li>')
    expect(roundTrip).toContain('Parent item')
    expect(roundTrip).toContain('Nested child')
    expect(roundTrip).toContain('Second child')
    expect(roundTrip).toContain('Sibling')
  })
})
