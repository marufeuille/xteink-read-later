import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractArticle } from '../src/extract/extract-article'
import { assignLanguage } from '../src/extract/pipeline'
import { detectLanguage, extractHtmlLang } from '../src/extract/detect-language'
import { buildEpub } from '../src/epub/build-epub'
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
})
