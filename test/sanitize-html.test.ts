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
