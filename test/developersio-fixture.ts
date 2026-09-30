export const DEVELOPERS_IO_ARTICLE_URL = 'https://dev.classmethod.jp/articles/reona-omarchy-try-on-mac/'
export const DEVELOPERS_IO_PUBLISHED_AT = '2026-09-28T08:43:42.110Z'
export const DEVELOPERS_IO_EVENT_DATETIME = '2026-10-27T15:00+09:00'

function flightScript(type: string, datePublished: string): string {
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': type,
    headline: 'Omarchy を macOS で試してみる',
    datePublished,
  })
  const fragment = `{"type":"application/ld+json","dangerouslySetInnerHTML":{"__html":${JSON.stringify(ld)}}}`
  return `<script>self.__next_f.push(${JSON.stringify([1, fragment])})</script>`
}

export function developersIoArticleHtml(options?: {
  readonly articleDate?: string | null
  readonly eventDate?: string | null
  readonly metaPublished?: string | null
  readonly jsonLdPublished?: string | null
}): string {
  const articleDate = options?.articleDate === undefined ? DEVELOPERS_IO_PUBLISHED_AT : options.articleDate
  const eventDate = options?.eventDate === undefined ? DEVELOPERS_IO_EVENT_DATETIME : options.eventDate
  const meta =
    options?.metaPublished !== undefined && options.metaPublished !== null
      ? `<meta property="article:published_time" content="${options.metaPublished}" />`
      : ''
  const jsonLd =
    options?.jsonLdPublished !== undefined && options.jsonLdPublished !== null
      ? `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: 'Omarchy を macOS で試してみる',
          datePublished: options.jsonLdPublished,
        })}</script>`
      : ''
  const times =
    eventDate === null
      ? ''
      : `<aside><time dateTime="${eventDate}">開催前イベント</time><time dateTime="2026-09-30T19:00+09:00">別の開催日</time></aside>`
  const flights = [
    eventDate === null ? '' : flightScript('Event', eventDate),
    articleDate === null ? '' : flightScript('Article', articleDate),
  ].join('')
  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>Omarchy を macOS で試してみる | DevelopersIO</title>
    <meta property="og:title" content="Omarchy を macOS で試してみる" />
    <meta property="og:site_name" content="DevelopersIO" />
    ${meta}
    <link rel="canonical" href="${DEVELOPERS_IO_ARTICLE_URL}" />
    ${jsonLd}
  </head>
  <body>
    ${times}
    <article>
      <h1>Omarchy を macOS で試してみる</h1>
      <p>
        DHH が開発している Linux ディストリビューション「Omarchy」を、Apple Silicon Mac で試せる「Try Omarchy」を使って実際に触ってみました。
        公開日は記事ヘッダーの日付であり、サイドバーの開催日ではない。
      </p>
      <p>本文が短いと抽出に失敗するので、候補登録と全文抽出の両方で同じ公開日を確認できる長さにする。</p>
    </article>
    ${flights}
  </body>
</html>`
}
