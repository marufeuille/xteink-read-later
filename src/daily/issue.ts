import { buildEpub } from '../epub/build-epub'
import { xmlEscape } from '../epub/xhtml'
import type { ArticleWrite, DailyIssueIdentity, HttpUrl, TranslatedArticle } from '../types'
import { dailyIssueIdentity } from './identity'

export async function buildDummyDailyWrite(input: {
  readonly date: string
  readonly origin: HttpUrl
  readonly bodyMarker?: string
}): Promise<{ identity: DailyIssueIdentity; write: ArticleWrite }> {
  const identity = await dailyIssueIdentity(input)
  const marker = input.bodyMarker ?? `DAY-${identity.date}`
  const article: TranslatedArticle = {
    title: identity.title,
    author: 'Xteink Read Later',
    publishedAt: identity.publishedAt,
    sourceUrl: identity.canonicalUrl,
    canonicalUrl: identity.canonicalUrl,
    contentHtml: `<h1>${xmlEscape(identity.title)}</h1><p>検証用のまとめ本文 ${xmlEscape(marker)}</p>`,
    language: 'ja',
    translated: false,
  }
  return {
    identity,
    write: {
      id: identity.articleId,
      title: identity.title,
      author: article.author,
      publishedAt: identity.publishedAt,
      sourceUrl: identity.canonicalUrl,
      canonicalUrl: identity.canonicalUrl,
      language: 'ja',
      translated: false,
      epub: await buildEpub(article, { identifier: identity.epubIdentifier }),
    },
  }
}
