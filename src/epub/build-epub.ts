import { zipSync, strToU8, type ZipOptions, type Zippable } from 'fflate'
import type { BuildEpub, TranslatedArticle } from '../types'
import { asEpubBytes } from '../types'
import { CONTAINER_XML, EPUB_CSS } from './templates'
import { htmlFragmentToXhtml, xmlEscape } from './xhtml'

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function headingEntries(xhtml: string): Array<{ href: string; label: string }> {
  const headings = [...xhtml.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
  return headings.map((match, index) => {
    const label = match[2]?.replace(/<[^>]+>/g, '').trim() ?? `Section ${index + 1}`
    return { href: `chapter.xhtml#h-${index + 1}`, label: label.length > 0 ? label : `Section ${index + 1}` }
  })
}

function withHeadingIds(xhtml: string): string {
  let index = 0
  return xhtml.replace(/<h([1-3])([^>]*)>/gi, (_all, level: string, attrs: string) => {
    index += 1
    if (/\sid=/.test(attrs)) {
      return `<h${level}${attrs}>`
    }
    return `<h${level}${attrs} id="h-${index}">`
  })
}

function navXhtml(title: string, entries: Array<{ href: string; label: string }>): string {
  const items =
    entries.length > 0
      ? entries
          .map((entry) => `<li><a href="${xmlEscape(entry.href)}">${xmlEscape(entry.label)}</a></li>`)
          .join('\n        ')
      : `<li><a href="chapter.xhtml">${xmlEscape(title)}</a></li>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
  <head>
    <title>${xmlEscape(title)}</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目次</h1>
      <ol>
        ${items}
      </ol>
    </nav>
  </body>
</html>
`
}

function chapterXhtml(article: TranslatedArticle, body: string): string {
  const published =
    article.publishedAt !== null
      ? `<p class="source">公開日: ${xmlEscape(article.publishedAt)}</p>`
      : ''
  const author =
    article.author !== null ? `<p class="source">著者: ${xmlEscape(article.author)}</p>` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
  <head>
    <title>${xmlEscape(article.title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <header>
      <p class="source"><a href="${xmlEscape(article.canonicalUrl)}">元記事</a></p>
      ${author}
      ${published}
    </header>
    ${body}
  </body>
</html>
`
}

function contentOpf(article: TranslatedArticle, bookId: string, modified: string): string {
  const creator =
    article.author !== null
      ? `<dc:creator>${xmlEscape(article.author)}</dc:creator>`
      : ''
  const date =
    article.publishedAt !== null
      ? `<dc:date>${xmlEscape(article.publishedAt)}</dc:date>`
      : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${xmlEscape(bookId)}</dc:identifier>
    <dc:title>${xmlEscape(article.title)}</dc:title>
    <dc:language>ja</dc:language>
    ${creator}
    <dc:source>${xmlEscape(article.canonicalUrl)}</dc:source>
    ${date}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>
`
}

export const buildEpub: BuildEpub = async (article) => {
  const modified = isoNow()
  const bookId = `urn:uuid:${crypto.randomUUID()}`
  const body = withHeadingIds(htmlFragmentToXhtml(article.contentHtml))
  const nav = navXhtml(article.title, headingEntries(body))
  const mimetype: [Uint8Array, ZipOptions] = [strToU8('application/epub+zip'), { level: 0 }]
  const files: Zippable = {
    mimetype,
    'META-INF/container.xml': strToU8(CONTAINER_XML),
    'OEBPS/content.opf': strToU8(contentOpf(article, bookId, modified)),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/chapter.xhtml': strToU8(chapterXhtml(article, body)),
    'OEBPS/style.css': strToU8(EPUB_CSS),
  }
  return asEpubBytes(zipSync(files))
}
