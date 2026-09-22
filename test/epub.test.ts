import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractArticle } from '../src/extract/extract-article'
import { assignLanguage } from '../src/extract/pipeline'
import { detectLanguage, extractHtmlLang } from '../src/extract/detect-language'
import { buildEpub } from '../src/epub/build-epub'
import { htmlFragmentToXhtml } from '../src/epub/xhtml'
import { EPUB_CSS } from '../src/epub/templates'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHttpUrl, type TranslatedArticle } from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function firstFileName(epub: Uint8Array): { name: string; method: number } {
  const view = new DataView(epub.buffer, epub.byteOffset, epub.byteLength)
  expect(view.getUint32(0, false)).toBe(0x504b0304)
  const method = view.getUint16(8, true)
  const nameLen = view.getUint16(26, true)
  const extraLen = view.getUint16(28, true)
  const name = new TextDecoder().decode(epub.slice(30, 30 + nameLen))
  expect(extraLen).toBe(0)
  return { name, method }
}

function translated(overrides: Partial<TranslatedArticle> = {}): TranslatedArticle {
  const url = parseHttpUrl('https://example.com/post')
  if (url === null) {
    throw new Error('fixture url')
  }
  return {
    title: '記事',
    author: null,
    publishedAt: null,
    sourceUrl: url,
    canonicalUrl: url,
    contentHtml: '<p>placeholder body text for the article.</p>',
    language: 'ja',
    translated: false,
    ...overrides,
  }
}

async function articleFromFixture(file: string, path: string): Promise<TranslatedArticle> {
  const url = parseHttpUrl(`https://example.com${path}`)
  if (url === null) {
    throw new Error(path)
  }
  const extracted = await extractArticle({
    requestedUrl: url,
    finalUrl: url,
    contentType: 'text/html',
    html: html(file),
  })
  if (!extracted.ok) {
    throw new Error(extracted.error.reason)
  }
  const language = detectLanguage({
    htmlLang: extractHtmlLang(html(file)),
    contentHtml: extracted.value.contentHtml,
  })
  const withLang = assignLanguage(extracted.value, language)
  return {
    ...withLang,
    language: 'ja',
    translated: language !== 'ja',
    title: language === 'ja' ? withLang.title : `${withLang.title}（日本語）`,
  }
}

describe('buildEpub', () => {
  it('writes a valid EPUB 3 zip with mimetype first and uncompressed', async () => {
    const article = await articleFromFixture('ja-tech.html', '/ja/workers-cpu')
    const epub = await buildEpub(article)
    const first = firstFileName(epub)
    expect(first.name).toBe('mimetype')
    expect(first.method).toBe(0)
    const files = unzipSync(epub)
    const names = Object.keys(files)
    expect(names).toEqual(
      expect.arrayContaining([
        'mimetype',
        'META-INF/container.xml',
        'OEBPS/content.opf',
        'OEBPS/nav.xhtml',
        'OEBPS/chapter.xhtml',
        'OEBPS/style.css',
      ]),
    )
    expect(strFromU8(files.mimetype ?? new Uint8Array())).toBe('application/epub+zip')
  })

  it.each([
    ['ja-tech.html', '/ja/workers-cpu', 'Cloudflare Workers の CPU 制限', 'npx wrangler dev'],
    ['en-tech.html', '/en/compatibility-date', 'compatibility_date', 'nodejs_compat'],
    ['en-news.html', '/news', 'committee voted', 'floor vote'],
  ] as const)('builds an intact EPUB for %s', async (file, path, titlePart, bodyPart) => {
    const article = await articleFromFixture(file, path)
    const epub = await buildEpub(article)
    const files = unzipSync(epub)
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const css = strFromU8(files['OEBPS/style.css'] ?? new Uint8Array())
    expect(opf).toContain('<dc:language>ja</dc:language>')
    expect(opf).toContain(`<dc:source>${article.canonicalUrl}</dc:source>`)
    expect(opf).toContain(titlePart)
    expect(opf).not.toMatch(/font-face|ttf|otf|woff/i)
    expect(chapter).toContain('元記事')
    expect(chapter).toContain(article.canonicalUrl)
    expect(chapter).toContain(bodyPart)
    expect(chapter).toMatch(/<h1/)
    expect(chapter).toMatch(/<p/)
    expect(css).toBe(EPUB_CSS)
    expect(css).not.toMatch(/font-family:\s*["']?[\w\s]+Noto|Hiragino|Yu Gothic/)
  })

  it('keeps pre/code as elements in chapter.xhtml', async () => {
    const article = translated({
      contentHtml: '<h1>Install</h1><p>Run the following.</p><pre><code>npm install</code></pre>',
    })
    const files = unzipSync(await buildEpub(article))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toMatch(/<pre[^>]*>\s*<code>npm install<\/code>\s*<\/pre>/)
    expect(chapter).not.toContain('&lt;code&gt;')
  })

  it('points the nav at preserved and generated heading ids without collisions', async () => {
    const article = translated({
      contentHtml:
        '<h1 id="intro">導入</h1><h2 id="usage">使用方法</h2><h2 id="h-1">注意</h2><h3>まとめ</h3>',
    })
    const files = unzipSync(await buildEpub(article))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const nav = strFromU8(files['OEBPS/nav.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('id="intro"')
    expect(chapter).toContain('id="usage"')
    expect(chapter).toContain('id="h-1"')
    expect(nav).toContain('href="chapter.xhtml#intro"')
    expect(nav).toContain('href="chapter.xhtml#usage"')
    expect(nav).toContain('href="chapter.xhtml#h-1"')
    expect(nav).toContain('href="chapter.xhtml#h-2"')
    expect(nav).not.toContain('href="chapter.xhtml#h-3"')
    const navIds = [...nav.matchAll(/href="chapter\.xhtml#([^"]+)"/g)].map((match) => match[1])
    const chapterIds = [...chapter.matchAll(/<h[1-3][^>]*\sid="([^"]+)"/g)].map((match) => match[1])
    expect(navIds).toEqual(chapterIds)
    expect(new Set(chapterIds).size).toBe(chapterIds.length)
  })

  it('writes EPUB 3 container, OPF manifest, and escaped metadata', async () => {
    const article = translated({
      title: 'A & B <C>',
      author: 'Ada & Grace',
      publishedAt: '2026-04-12T00:00:00.000Z',
      contentHtml: '<h1>A &amp; B</h1><p>Body text for the chapter.</p>',
    })
    const epub = await buildEpub(article)
    const files = unzipSync(epub)
    const container = strFromU8(files['META-INF/container.xml'] ?? new Uint8Array())
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(container).toContain('full-path="OEBPS/content.opf"')
    expect(container).toContain('application/oebps-package+xml')
    expect(opf).toMatch(/<package[^>]*version="3.0"/)
    expect(opf).toContain('unique-identifier="bookid"')
    expect(opf).toContain('<item id="nav" href="nav.xhtml"')
    expect(opf).toContain('<item id="chapter" href="chapter.xhtml"')
    expect(opf).toContain('<item id="css" href="style.css"')
    expect(opf).toContain('<itemref idref="chapter"/>')
    expect(opf).toContain('<dc:title>A &amp; B &lt;C&gt;</dc:title>')
    expect(opf).toContain('<dc:creator>Ada &amp; Grace</dc:creator>')
    expect(opf).toContain('<dc:date>2026-04-12T00:00:00.000Z</dc:date>')
    expect(opf).toContain('<dc:language>ja</dc:language>')
    expect(chapter).toContain('xml:lang="ja"')
    expect(chapter).toContain('著者: Ada &amp; Grace')
    expect(chapter).toContain('公開日: 2026-04-12T00:00:00.000Z')
  })

  it('writes a caller-supplied EPUB identifier instead of a random UUID', async () => {
    const article = translated({ title: 'まとめ 2026-09-21' })
    const files = unzipSync(await buildEpub(article, { identifier: 'urn:xteink:daily:2026-09-21' }))
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    expect(opf).toContain('<dc:identifier id="bookid">urn:xteink:daily:2026-09-21</dc:identifier>')
    expect(opf).not.toContain('urn:uuid:')
  })

  it('strips NUL and remote img from chapter XHTML, keeping alt text', async () => {
    const article = translated({
      contentHtml:
        '<p>Dummy\u0000 body.</p>' +
        '<p>Keep\ttab and\nLF.</p>' +
        '<p>Bell\u0007 gone.</p>' +
        '<p><img src="https://example.com/chart.svg" alt="SVG chart caption"/></p>' +
        '<p><img src="https://example.com/photo.png" alt="PNG photo caption"/></p>' +
        '<p><img src="data:image/png;base64,AAAA" alt="Data URI caption"/></p>' +
        '<p><img src="https://example.com/blank.svg"/></p>',
    })
    const xhtml = htmlFragmentToXhtml(article.contentHtml)
    expect(xhtml).not.toContain('\u0000')
    expect(xhtml).not.toContain('\u0007')
    expect(xhtml).toContain('\t')
    expect(xhtml).toContain('\n')
    expect(xhtml).not.toMatch(/<img\b/i)
    expect(xhtml).toContain('SVG chart caption')
    expect(xhtml).toContain('PNG photo caption')
    expect(xhtml).toContain('Data URI caption')
    expect(xhtml).not.toContain('example.com/chart.svg')
    expect(xhtml).not.toContain('data:image/png')

    const files = unzipSync(await buildEpub(article))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())
    expect(chapter.includes('\u0000')).toBe(false)
    expect(chapter).not.toMatch(/<img\b/i)
    expect(chapter).toContain('SVG chart caption')
    expect(chapter).toContain('Dummy body.')
    expect(opf).not.toContain('image/png')
    expect(Object.keys(files).filter((name) => name.endsWith('.png'))).toEqual([])
  })

  it('strips page CLI warn tokens from chapter XHTML and keeps dct render', async () => {
    const article = translated({
      contentHtml:
        '<p>Dummy charts body.</p>' +
        '<pre><code>dct render\nWARN-BAR-BAND-WIDTH-TOO-NARROW\nWARN-TABLE-COLUMNS-OVERFLOW\n</code></pre>',
    })
    const files = unzipSync(await buildEpub(article))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('dct render')
    expect(chapter).not.toContain('WARN-BAR-BAND-WIDTH-TOO-NARROW')
    expect(chapter).not.toContain('WARN-TABLE-COLUMNS-OVERFLOW')
  })

  it('strips chart axis tick lists from chapter XHTML and keeps real steps', async () => {
    const article = translated({
      contentHtml:
        '<p>Dummy charts body about nodejs_compat.</p>' +
        '<ol aria-hidden="true"><li>&lt;</li><li>2</li><li>0</li><li>12</li><li>01234567890123456</li></ol>' +
        '<ol><li>Enable nodejs_compat</li><li>Keep compatibility_date current</li></ol>',
    })
    const files = unzipSync(await buildEpub(article))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('Dummy charts body about nodejs_compat.')
    expect(chapter).toContain('Enable nodejs_compat')
    expect(chapter).not.toContain('01234567890123456')
    expect(chapter).not.toMatch(/<li>\s*&lt;\s*<\/li>/)
  })

  it('strips Sign in / Join Waitlist menu chrome from chapter XHTML', async () => {
    const article = await articleFromFixture('nav-chrome.html', '/blog/system-one')
    const files = unzipSync(await buildEpub(article))
    const chapter = strFromU8(files['OEBPS/chapter.xhtml'] ?? new Uint8Array())
    expect(chapter).toContain('nodejs_compat')
    expect(chapter).not.toContain('Sign in')
    expect(chapter).not.toContain('Join Waitlist')
    expect(chapter).not.toContain('Manifesto')
    expect(chapter).not.toContain('∵ Back')
    expect(chapter).not.toContain('Privacy Policy')
  })
})
