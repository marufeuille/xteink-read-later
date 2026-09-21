import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectLanguage, extractHtmlLang } from '../src/extract/detect-language'
import { extractArticle } from '../src/extract/extract-article'
import { parseHttpUrl } from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function page(path: string, file: string) {
  const url = parseHttpUrl(`https://example.com${path}`)
  if (url === null) {
    throw new Error('fixture url')
  }
  return {
    requestedUrl: url,
    finalUrl: url,
    contentType: 'text/html',
    html: html(file),
  }
}

describe('extractArticle', () => {
  it('extracts a Japanese tech article and drops nav/script/ads', async () => {
    const result = await extractArticle(page('/ja/workers-cpu', 'ja-tech.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe('Cloudflare Workers の CPU 制限')
    expect(result.value.author).toBe('石井')
    expect(result.value.canonicalUrl).toBe('https://example.com/ja/workers-cpu')
    expect(result.value.publishedAt).toBe('2026-03-01T00:00:00.000Z')
    expect(result.value.contentHtml).toContain('Paid プランを前提にする')
    expect(result.value.contentHtml).toMatch(/<pre>\s*<code>npx wrangler dev<\/code>\s*<\/pre>/)
    expect(result.value.contentHtml).not.toContain('&lt;code&gt;')
    expect(result.value.contentHtml).not.toContain('ホーム')
    expect(result.value.contentHtml).not.toContain('広告プレースホルダ')
    expect(result.value.contentHtml).not.toContain('window.ads')
    expect(result.value.contentHtml).not.toContain('フッターの著作権表示')
  })

  it('keeps nested emphasis phrases used by Japanese X articles', async () => {
    const result = await extractArticle(page('/ja/self-repair-loop', 'emphasis-nested.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe('自己修正ループ')
    expect(result.value.contentHtml).toContain('人間がボトルネック')
    expect(result.value.contentHtml).toContain('Claude Codeだけ')
    expect(result.value.contentHtml).toContain('公式ドキュメント')
    expect(result.value.contentHtml).toContain('/goal')
  })

  it('extracts an English tech article', async () => {
    const result = await extractArticle(page('/en/compatibility-date', 'en-tech.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe('Keep compatibility_date current')
    expect(result.value.author).toBe('Ada Lovelace')
    expect(result.value.contentHtml).toContain('nodejs_compat')
    expect(result.value.contentHtml).toContain('compatibility_date')
    expect(result.value.contentHtml).not.toContain('Related posts you may like')
    expect(result.value.contentHtml).not.toContain('Sponsored advertisement')
  })

  it('extracts English news metadata', async () => {
    const result = await extractArticle(page('/ignored', 'en-news.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe('The committee voted on the measure')
    expect(result.value.author).toBe('Riley Chen')
    expect(result.value.canonicalUrl).toBe('https://news.example.com/2026/committee-vote')
    expect(result.value.publishedAt).toBe('2026-05-20T15:30:00.000Z')
    expect(result.value.contentHtml).toContain('The committee voted late Tuesday')
    expect(result.value.contentHtml).not.toContain('Share on social networks')
  })

  it('fails when the page has no article body', async () => {
    const result = await extractArticle(page('/empty', 'empty.html'))
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.kind).toBe('extract_failed')
  })

  it('keeps pre/code as elements and unwraps highlighter spans', async () => {
    const result = await extractArticle(page('/pre-code', 'pre-code.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.contentHtml).toMatch(
      /<pre>\s*<code class="language-js">const x = 1;<\/code>\s*<\/pre>/,
    )
    expect(result.value.contentHtml).not.toContain('&lt;code')
    expect(result.value.contentHtml).not.toContain('&lt;span')
    expect(result.value.contentHtml).not.toContain('class="token"')
  })

  it('keeps highlighter comments inside pre/code instead of stripping them as page noise', async () => {
    const result = await extractArticle(page('/payments', 'code-comments.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.contentHtml).toContain('Do not retry this non-idempotent operation.')
    expect(result.value.contentHtml).toContain('submitPayment()')
    expect(result.value.contentHtml).toContain('second highlighter comment token')
    expect(result.value.contentHtml).toMatch(/<pre>\s*<code>/)
  })

  it('fails when the extracted body is too short', async () => {
    const result = await extractArticle(page('/tiny', 'too-short.html'))
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.kind).toBe('extract_failed')
    expect(result.error.reason).toMatch(/too short|No article body found/i)
  })

  it('fails when the page has a body but no title', async () => {
    const result = await extractArticle(page('/untitled', 'missing-title.html'))
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.kind).toBe('extract_failed')
    expect(result.error.reason).toBe('Missing title')
  })

  it('reads title, authors, and date from JSON-LD @graph', async () => {
    const result = await extractArticle(page('/graph', 'json-ld-graph.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe('Committee reaches a late vote')
    expect(result.value.author).toBe('Ada Lovelace, Grace Hopper')
    expect(result.value.publishedAt).toBe('2026-06-02T12:00:00.000Z')
    expect(result.value.contentHtml).toContain('unique-graph-body')
  })

  it('prefers itemprop=articleBody over a longer featured teaser', async () => {
    const result = await extractArticle(page('/itemprop', 'itemprop-article-body.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.contentHtml).toContain('unique-itemprop-body')
    expect(result.value.contentHtml).not.toContain('unique-featured-teaser')
    expect(result.value.contentHtml).not.toContain('completely different story')
  })

  it('prefers the main article over a featured preview article', async () => {
    const result = await extractArticle(page('/posts/real-story', 'featured-preview.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.contentHtml).toContain('unique-main-body')
    expect(result.value.contentHtml).not.toContain('completely different story')
  })

  it('resolves relative links against the fetched URL, not canonical', async () => {
    const fetched = parseHttpUrl('https://example.com/amp/posts/story/')
    if (fetched === null) {
      throw new Error('fetched url')
    }
    const result = await extractArticle({
      requestedUrl: fetched,
      finalUrl: fetched,
      contentType: 'text/html',
      html: html('amp-relative.html'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.canonicalUrl).toBe('https://example.com/posts/story/')
    expect(result.value.contentHtml).toContain('https://example.com/amp/posts/reference/')
    expect(result.value.contentHtml).not.toContain('https://example.com/posts/reference/')
  })

  it('drops aria-hidden chart ticks and leftover markup lists from the article body', async () => {
    const result = await extractArticle(page('/charts/ticks', 'chart-ticks.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.contentHtml).toContain('compatibility_date')
    expect(result.value.contentHtml).toContain('Enable nodejs_compat')
    expect(result.value.contentHtml).not.toContain('01234567890123456')
    expect(result.value.contentHtml).not.toContain('aria-hidden')
    expect(result.value.contentHtml).not.toMatch(/<li>\s*&lt;\s*<\/li>/)
    expect(result.value.contentHtml).not.toMatch(/<li>\s*12\s*<\/li>/)
  })

  it('drops site menu chrome such as Sign in and Join Waitlist', async () => {
    const result = await extractArticle(page('/blog/system-one', 'nav-chrome.html'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe('Dummy System One models')
    expect(result.value.contentHtml).toContain('nodejs_compat')
    expect(result.value.contentHtml).toContain('cpu_ms')
    expect(result.value.contentHtml).not.toContain('Sign in')
    expect(result.value.contentHtml).not.toContain('Join Waitlist')
    expect(result.value.contentHtml).not.toContain('Join waitlist')
    expect(result.value.contentHtml).not.toContain('Manifesto')
    expect(result.value.contentHtml).not.toContain('Our Team')
    expect(result.value.contentHtml).not.toContain('∵ Back')
    expect(result.value.contentHtml).not.toContain('Privacy Policy')
    expect(result.value.contentHtml).not.toContain('Terms of Use')
  })

  it('extracts an English X article served with Japanese UI chrome as non-ja', async () => {
    const fetched = page('/x-article', 'x-article-ja-ui.html')
    const result = await extractArticle(fetched)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe(
      'Jev Engineering: Full 10-Step Roadmap to Set Up and Use a New Brain for AI (from scratch)',
    )
    expect(result.value.title).not.toContain('Xユーザー')
    expect(result.value.contentHtml).toContain('The Jevons Paradox is a rule')
    expect(result.value.contentHtml).toContain('standalone task router')
    expect(result.value.contentHtml).toContain('Goal: Compare three AI-agent tools')
    expect(result.value.contentHtml).not.toContain('ホーム')
    expect(result.value.contentHtml).not.toContain('話題を検索')
    expect(
      detectLanguage({
        htmlLang: extractHtmlLang(fetched.html),
        contentHtml: result.value.contentHtml,
      }),
    ).toBe('non-ja')
  })

  it('uses og:description when an X page has only profile chrome and no article heading', async () => {
    const source = page('/x-article', 'x-article-ja-ui.html')
    const result = await extractArticle({
      ...source,
      html: source.html.replace(/<h1>[\s\S]*?<\/h1>/, ''),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe(
      'Jev Engineering: Full 10-Step Roadmap to Set Up and Use a New Brain for AI (from scratch)',
    )
    expect(result.value.title).not.toContain('Xユーザー')
  })

  it('uses the article heading when an earlier h1 is the X profile name', async () => {
    const source = page('/x-article', 'x-article-ja-ui.html')
    const result = await extractArticle({
      ...source,
      html: source.html
        .replace(/<meta\s+property="og:description"[\s\S]*?\/>/, '')
        .replace('<body>', '<body><h1>Xユーザーのcodila（@0xCodila）さん</h1>'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.title).toBe(
      'Jev Engineering: Full 10-Step Roadmap to Set Up and Use a New Brain for AI (from scratch)',
    )
  })
})
