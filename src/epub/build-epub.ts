import { zipSync, strToU8, type ZipOptions, type Zippable } from 'fflate'
import type { EpubBytes, TranslatedArticle } from '../types'
import { asEpubBytes } from '../types'
import { CONTAINER_XML, EPUB_CSS } from './templates'
import { htmlFragmentToXhtml, xmlEscape } from './xhtml'

type HeadingEntry = { href: string; label: string }

const IMAGE_HREF = /^images\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/

export type EpubImage = {
  readonly id: string
  readonly href: string
  readonly bytes: Uint8Array
}

function assertImageHref(href: string): void {
  if (!IMAGE_HREF.test(href) || href.includes('..')) {
    throw new TypeError('Unsafe EPUB image path')
  }
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function idFromAttrs(attrs: string): string | null {
  const quoted = /\sid\s*=\s*["']([^"']*)["']/i.exec(attrs)
  if (quoted?.[1] !== undefined && quoted[1].length > 0) {
    return quoted[1]
  }
  const bare = /\sid\s*=\s*([^\s>]+)/i.exec(attrs)
  if (bare?.[1] !== undefined && bare[1].length > 0) {
    return bare[1]
  }
  return null
}

function stripIdAttr(attrs: string): string {
  return attrs.replace(/\s+id\s*=\s*(["'][^"']*["']|[^\s>]+)/i, '')
}

function nextGeneratedId(used: Set<string>): string {
  let n = 1
  let id = `h-${n}`
  while (used.has(id)) {
    n += 1
    id = `h-${n}`
  }
  return id
}

function assignHeadingId(existing: string | null, used: Set<string>): string {
  if (existing !== null && !used.has(existing)) {
    used.add(existing)
    return existing
  }
  const id = nextGeneratedId(used)
  used.add(id)
  return id
}

function withHeadingIds(xhtml: string): { xhtml: string; entries: HeadingEntry[] } {
  const used = new Set<string>()
  const entries: HeadingEntry[] = []
  const updated = xhtml.replace(
    /<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_all, level: string, attrs: string, inner: string) => {
      const id = assignHeadingId(idFromAttrs(attrs), used)
      const label = inner.replace(/<[^>]+>/g, '').trim()
      const fallback = `Section ${entries.length + 1}`
      entries.push({
        href: `chapter.xhtml#${id}`,
        label: label.length > 0 ? label : fallback,
      })
      return `<h${level}${stripIdAttr(attrs)} id="${xmlEscape(id)}">${inner}</h${level}>`
    },
  )
  return { xhtml: updated, entries }
}

function navXhtml(title: string, entries: HeadingEntry[]): string {
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

function contentOpf(
  article: TranslatedArticle,
  bookId: string,
  modified: string,
  images: readonly EpubImage[],
): string {
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
    ${images
      .map(
        (image) =>
          `<item id="${xmlEscape(image.id)}" href="${xmlEscape(image.href)}" media-type="image/png"/>`,
      )
      .join('\n    ')}
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>
`
}

export async function buildEpub(
  article: TranslatedArticle,
  options: { readonly identifier?: string; readonly images?: readonly EpubImage[] } = {},
): Promise<EpubBytes> {
  const modified = isoNow()
  const bookId =
    options.identifier !== undefined && options.identifier.length > 0
      ? options.identifier
      : `urn:uuid:${crypto.randomUUID()}`
  const images = options.images ?? []
  for (const image of images) {
    assertImageHref(image.href)
  }
  const preserveImageSrcs = new Set(images.map((image) => image.href))
  const converted = withHeadingIds(
    htmlFragmentToXhtml(
      article.contentHtml,
      preserveImageSrcs.size > 0 ? { preserveImageSrcs } : {},
    ),
  )
  const nav = navXhtml(article.title, converted.entries)
  const mimetype: [Uint8Array, ZipOptions] = [strToU8('application/epub+zip'), { level: 0 }]
  const files: Zippable = {
    mimetype,
    'META-INF/container.xml': strToU8(CONTAINER_XML),
    'OEBPS/content.opf': strToU8(contentOpf(article, bookId, modified, images)),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/chapter.xhtml': strToU8(chapterXhtml(article, converted.xhtml)),
    'OEBPS/style.css': strToU8(EPUB_CSS),
  }
  for (const image of images) {
    files[`OEBPS/${image.href}`] = image.bytes
  }
  return asEpubBytes(zipSync(files))
}
