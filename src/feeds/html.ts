import { FEED_SOURCE_TYPES, type FeedSource, type FeedSourcePublic, type FeedSourceType } from '../types'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export { escapeHtml }

const STYLES = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 1rem; max-width: 40rem; line-height: 1.5; }
h1 { font-size: 1.25rem; }
label { display: block; margin: 0.75rem 0 0.35rem; }
input[type="url"], input[type="text"], input[type="password"], select, textarea {
  width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.65rem;
}
button { font-size: 1rem; padding: 0.7rem 1rem; min-height: 44px; margin-top: 0.75rem; margin-right: 0.5rem; }
.notice { padding: 0.75rem 1rem; margin: 0 0 1rem; border-radius: 0.4rem; background: color-mix(in srgb, CanvasText 8%, Canvas); }
.note { font-size: 0.9rem; color: color-mix(in srgb, CanvasText 70%, Canvas); }
.item { border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); padding: 0.85rem 0; }
.meta { font-size: 0.9rem; }
nav { display: flex; gap: 1rem; margin-top: 1.25rem; flex-wrap: wrap; }
.actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
`.trim()

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`
}

export function htmlResponse(title: string, body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(layout(title, body), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...headers,
    },
  })
}

export const SOURCE_TYPE_LABELS: Record<FeedSourceType, string> = {
  corporate_blog: '企業ブログ',
  posting_site: '投稿サイト',
  news: 'ニュース',
  curation: 'キュレーション',
}

export function sourceTypeLabel(type: FeedSourceType): string {
  return SOURCE_TYPE_LABELS[type]
}

function typeOptions(selected: FeedSourceType | ''): string {
  return FEED_SOURCE_TYPES.map((type) => {
    const isSelected = type === selected ? ' selected' : ''
    return `<option value="${type}"${isSelected}>${escapeHtml(SOURCE_TYPE_LABELS[type])}</option>`
  }).join('')
}

function enabledOptions(enabled: boolean): string {
  return `<option value="1"${enabled ? ' selected' : ''}>有効</option>
<option value="0"${enabled ? '' : ' selected'}>停止</option>`
}

function collectionMeta(source: FeedSourcePublic): string {
  if (source.collectionStatus === null) {
    return 'まだ収集していません'
  }
  if (source.collectionStatus === 'queued' || source.collectionStatus === 'running') {
    return source.collectionStatus === 'queued' ? '収集待ち' : '収集中'
  }
  if (source.collectionStatus === 'failed') {
    const detail = source.collectionErrorMessage ?? source.collectionErrorCode ?? '失敗'
    return `失敗: ${detail}`
  }
  return `前回 新規${source.itemsRegistered} / 重複${source.itemsDuplicate} / スキップ${source.itemsSkipped}`
}

function sourceCard(source: FeedSourcePublic, csrfToken: string): string {
  const tags = source.topicTags.join(', ')
  const collectLabel = source.collectionStatus === 'failed' ? '再実行' : '今すぐ収集'
  return `<article class="item">
  <h2>${escapeHtml(source.name)}</h2>
  <p class="meta">${escapeHtml(sourceTypeLabel(source.sourceType))} · ${source.enabled ? '有効' : '停止'}</p>
  <p class="meta">${escapeHtml(collectionMeta(source))}</p>
  <p class="meta">話題タグ: ${tags.length > 0 ? escapeHtml(tags) : 'なし'}</p>
  <p><a href="${escapeHtml(source.siteUrl)}">サイト</a> · <a href="${escapeHtml(source.feedUrl)}">フィード</a></p>
  <form method="post" action="/sources/${escapeHtml(source.id)}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
    <label for="name-${escapeHtml(source.id)}">名前</label>
    <input id="name-${escapeHtml(source.id)}" name="name" type="text" required value="${escapeHtml(source.name)}" />
    <label for="site-${escapeHtml(source.id)}">サイト URL</label>
    <input id="site-${escapeHtml(source.id)}" name="site_url" type="url" required value="${escapeHtml(source.siteUrl)}" />
    <label for="feed-${escapeHtml(source.id)}">フィード URL</label>
    <input id="feed-${escapeHtml(source.id)}" name="feed_url" type="url" required value="${escapeHtml(source.feedUrl)}" />
    <label for="type-${escapeHtml(source.id)}">情報源種別</label>
    <select id="type-${escapeHtml(source.id)}" name="source_type">${typeOptions(source.sourceType)}</select>
    <label for="tags-${escapeHtml(source.id)}">話題タグ（任意・カンマ区切り）</label>
    <input id="tags-${escapeHtml(source.id)}" name="topic_tags" type="text" value="${escapeHtml(tags)}" />
    <label for="enabled-${escapeHtml(source.id)}">状態</label>
    <select id="enabled-${escapeHtml(source.id)}" name="enabled">${enabledOptions(source.enabled)}</select>
    <div class="actions">
      <button type="submit">保存</button>
    </div>
  </form>
  <form method="post" action="/sources/${escapeHtml(source.id)}/collect">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
    <button type="submit"${source.enabled ? '' : ' disabled'}>${escapeHtml(collectLabel)}</button>
  </form>
</article>`
}

export function sourcesPageHtml(input: {
  readonly sources: readonly FeedSourcePublic[]
  readonly csrfToken: string
  readonly notice?: string
}): string {
  const notice =
    input.notice === undefined ? '' : `<p class="notice" role="status">${escapeHtml(input.notice)}</p>`
  const list =
    input.sources.length === 0
      ? '<p>まだ情報源はありません。</p>'
      : input.sources.map((source) => sourceCard(source, input.csrfToken)).join('\n')
  return `<h1>情報源</h1>
${notice}
<nav><a href="/candidates">候補一覧</a></nav>
<p class="note">RSS/Atom だけを対象にします。サイトからフィードを見つけられないときはフィード URL を入れてください。情報源種別は記事の話題とは別です。停止しても既存の候補は消しません。</p>
<form method="post" action="/sources">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  <label for="name">名前</label>
  <input id="name" name="name" type="text" required placeholder="Zenn Cloudflare" />
  <label for="site_url">サイト URL</label>
  <input id="site_url" name="site_url" type="url" inputmode="url" required placeholder="https://" />
  <label for="feed_url">フィード URL（任意）</label>
  <input id="feed_url" name="feed_url" type="url" inputmode="url" placeholder="見つからないときだけ" />
  <label for="source_type">情報源種別</label>
  <select id="source_type" name="source_type">${typeOptions('corporate_blog')}</select>
  <label for="topic_tags">話題タグ（任意・カンマ区切り）</label>
  <input id="topic_tags" name="topic_tags" type="text" placeholder="cloudflare, workers" />
  <label for="enabled">状態</label>
  <select id="enabled" name="enabled">${enabledOptions(true)}</select>
  <button type="submit">情報源を追加</button>
</form>
<form method="post" action="/sources/collect">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  <button type="submit">有効な情報源をすべて収集</button>
</form>
<form method="post" action="/digest">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  <button type="submit">今日のまとめを作る</button>
</form>
<p class="note">まとめは 06:00（Asia/Tokyo）にも作られます。このボタンは同じ Queue に当日号を予約します。</p>
${list}
<form method="post" action="/candidates/logout">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  <button type="submit">出る</button>
</form>`
}

export function sourceNoticeMessage(kind: string | undefined): string | undefined {
  switch (kind) {
    case 'created':
      return '情報源を登録しました'
    case 'updated':
      return '情報源を更新しました'
    case 'duplicate':
      return '同じフィードはすでに登録されています'
    case 'queued':
      return '収集を予約しました'
    case 'digest_queued':
      return 'まとめ生成を予約しました'
    case 'digest_failed':
      return 'まとめを予約できませんでした。しばらくしてからもう一度押してください'
    case 'feed_missing':
      return 'サイトからフィードを見つけられませんでした。フィード URL を入力してください'
    case 'stopped':
      return '停止中の情報源は収集しません'
    default:
      return undefined
  }
}
