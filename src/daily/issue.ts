import { digestConfirmUrl, digestQrExpiresAt, signDigestQrToken } from '../digest/confirm-link'
import { qrPng } from '../digest/qr-png'
import { buildEpub, type EpubImage } from '../epub/build-epub'
import { xmlEscape } from '../epub/xhtml'
import {
  parseHttpUrl,
  type ArticleWrite,
  type DailyIssueIdentity,
  type DigestPreparedItem,
  type HttpUrl,
  type TranslatedArticle,
} from '../types'
import { dailyIssueIdentity } from './identity'

const DIGEST_AUTHOR = 'Xteink Read Later'

const DIGEST_IDENTITY_ORIGIN: HttpUrl = (() => {
  const origin = parseHttpUrl('https://daily.invalid')
  if (origin === null) {
    throw new TypeError('Invalid daily identity origin')
  }
  return origin
})()

function digestSectionHtml(item: DigestPreparedItem, qrHref?: string): string {
  const url = xmlEscape(item.canonicalUrl)
  const qr =
    qrHref === undefined ? '' : `<p><img src="${xmlEscape(qrHref)}" alt="全文を送る"/></p>`
  return (
    `<h2 id="${xmlEscape(item.candidateId)}"><a href="${url}">${xmlEscape(item.title)}</a></h2>` +
    `<p class="source"><a href="${url}">${url}</a></p>` +
    item.summaryHtml +
    qr
  )
}

function digestContentHtml(date: string, items: readonly DigestPreparedItem[]): string {
  return `<h1>${xmlEscape(`まとめ ${date}`)}</h1>${items.map((item) => digestSectionHtml(item)).join('')}`
}

function digestArticle(
  identity: DailyIssueIdentity,
  contentHtml: string,
  translated: boolean,
): TranslatedArticle {
  return {
    title: identity.title,
    author: DIGEST_AUTHOR,
    publishedAt: identity.publishedAt,
    sourceUrl: identity.canonicalUrl,
    canonicalUrl: identity.canonicalUrl,
    contentHtml,
    language: 'ja',
    translated,
  }
}

async function writeDailyIssue(
  identity: DailyIssueIdentity,
  article: TranslatedArticle,
  images: readonly EpubImage[] = [],
): Promise<{ identity: DailyIssueIdentity; write: ArticleWrite }> {
  return {
    identity,
    write: {
      id: identity.articleId,
      title: identity.title,
      author: article.author,
      publishedAt: identity.publishedAt,
      sourceUrl: identity.canonicalUrl,
      canonicalUrl: identity.canonicalUrl,
      language: article.language,
      translated: article.translated,
      epub: await buildEpub(article, {
        identifier: identity.epubIdentifier,
        ...(images.length > 0 ? { images } : {}),
      }),
    },
  }
}

async function digestQrContent(
  date: string,
  items: readonly DigestPreparedItem[],
  qr: { readonly publicOrigin: string; readonly secret: string },
): Promise<{ readonly contentHtml: string; readonly images: EpubImage[] }> {
  const expiresAt = digestQrExpiresAt(date)
  const images: EpubImage[] = []
  const sections: string[] = []
  for (const item of items) {
    const token = await signDigestQrToken({
      secret: qr.secret,
      candidateId: item.candidateId,
      expiresAt,
    })
    const href = `images/qr-${item.candidateId}.png`
    images.push({
      id: `qr-${item.candidateId}`,
      href,
      bytes: qrPng(digestConfirmUrl(qr.publicOrigin, item.candidateId, expiresAt, token)),
    })
    sections.push(digestSectionHtml(item, href))
  }
  return {
    contentHtml: `<h1>${xmlEscape(`まとめ ${date}`)}</h1>${sections.join('')}`,
    images,
  }
}

export async function buildDailyDigestWrite(input: {
  readonly date: string
  readonly items: readonly DigestPreparedItem[]
  readonly origin?: HttpUrl
  readonly qr?: { readonly publicOrigin: string; readonly secret: string }
}): Promise<{ identity: DailyIssueIdentity; write: ArticleWrite }> {
  const identity = await dailyIssueIdentity({
    date: input.date,
    origin: input.origin ?? DIGEST_IDENTITY_ORIGIN,
  })
  if (input.qr === undefined) {
    return writeDailyIssue(identity, digestArticle(identity, digestContentHtml(identity.date, input.items), true))
  }
  const rendered = await digestQrContent(identity.date, input.items, input.qr)
  return writeDailyIssue(identity, digestArticle(identity, rendered.contentHtml, true), rendered.images)
}

export async function buildDummyDailyWrite(input: {
  readonly date: string
  readonly origin: HttpUrl
  readonly bodyMarker?: string
}): Promise<{ identity: DailyIssueIdentity; write: ArticleWrite }> {
  const identity = await dailyIssueIdentity(input)
  const marker = input.bodyMarker ?? `DAY-${identity.date}`
  return writeDailyIssue(
    identity,
    digestArticle(identity, `<h1>${xmlEscape(identity.title)}</h1><p>検証用のまとめ本文 ${xmlEscape(marker)}</p>`, false),
  )
}
