import { xmlEscape } from '../epub/xhtml'
import { asArticleId, isArticleId, type ArticleId, type ArticleMeta, type HttpUrl, type OpdsCatalog } from '../types'

export const OPDS_CATALOG_TITLE = 'Xteink Read Later'
export const OPDS_CATALOG_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition'
export const OPDS_ACQUISITION_REL = 'http://opds-spec.org/acquisition'
export const OPDS_CACHE_CONTROL = 'no-store'

export function opdsDownloadPath(id: ArticleId): `/opds/download/${ArticleId}.epub` {
  return `/opds/download/${id}.epub`
}

export function opdsFilename(id: ArticleId): `${ArticleId}.epub` {
  return `${id}.epub`
}

export function originBase(origin: HttpUrl): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

export function opdsEntryHref(origin: HttpUrl, id: ArticleId): string {
  return `${originBase(origin)}/articles/${id}`
}

export function opdsAcquisitionHref(origin: HttpUrl, id: ArticleId): string {
  return `${originBase(origin)}${opdsDownloadPath(id)}`
}

export function parseOpdsDownloadFile(file: string): ArticleId | null {
  if (!file.endsWith('.epub')) {
    return null
  }
  const id = file.slice(0, -'.epub'.length)
  return isArticleId(id) ? asArticleId(id) : null
}

export function buildOpdsCatalog(articles: readonly ArticleMeta[], origin: HttpUrl): OpdsCatalog {
  const base = originBase(origin)
  const catalogHref = `${base}/opds`
  const updated = articles[0]?.updatedAt ?? new Date().toISOString()
  const entries = articles.map((article) => {
    const author =
      article.author !== null && article.author.length > 0
        ? `
    <author>
      <name>${xmlEscape(article.author)}</name>
    </author>`
        : ''
    const published =
      article.publishedAt !== null && article.publishedAt.length > 0
        ? `
    <published>${xmlEscape(article.publishedAt)}</published>`
        : ''
    return `
  <entry>
    <id>${xmlEscape(opdsEntryHref(origin, article.id))}</id>
    <title>${xmlEscape(article.title)}</title>
    <updated>${xmlEscape(article.updatedAt)}</updated>${published}${author}
    <dc:language>ja</dc:language>
    <link rel="alternate" href="${xmlEscape(article.canonicalUrl)}" type="text/html"/>
    <link rel="${OPDS_ACQUISITION_REL}" href="${xmlEscape(opdsAcquisitionHref(origin, article.id))}" type="application/epub+zip"/>
  </entry>`
  })
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xmlEscape(catalogHref)}</id>
  <title>${xmlEscape(OPDS_CATALOG_TITLE)}</title>
  <updated>${xmlEscape(updated)}</updated>
  <author>
    <name>${xmlEscape(OPDS_CATALOG_TITLE)}</name>
  </author>
  <link rel="self" href="${xmlEscape(catalogHref)}" type="${xmlEscape(OPDS_CATALOG_TYPE)}"/>
  <link rel="start" href="${xmlEscape(catalogHref)}" type="${xmlEscape(OPDS_CATALOG_TYPE)}"/>${entries.join('')}
</feed>
`
  return { xml }
}
