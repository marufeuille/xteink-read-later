import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
    expect(result.value.contentHtml).toContain('npx wrangler dev')
    expect(result.value.contentHtml).not.toContain('ホーム')
    expect(result.value.contentHtml).not.toContain('広告プレースホルダ')
    expect(result.value.contentHtml).not.toContain('window.ads')
    expect(result.value.contentHtml).not.toContain('フッターの著作権表示')
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
})
