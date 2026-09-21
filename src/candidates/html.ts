import { CANDIDATE_LIST_TIMEZONE, type CandidateListBody, type CandidateNotice, type CandidatePublic } from '../types'
import { CANDIDATE_TIMEZONE_NOTE, calendarDateInTimeZone } from './list'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function statusLabel(item: CandidatePublic): string {
  if (item.fetchStatus === 'fetch_failed') {
    return '取得失敗'
  }
  if (item.fullTextState === 'confirmed_free') {
    return '無料全文を確認'
  }
  return 'メタデータのみ'
}

const STYLES = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 1rem; max-width: 40rem; line-height: 1.5; }
h1 { font-size: 1.25rem; }
label { display: block; margin: 0.75rem 0 0.35rem; }
input[type="url"], input[type="password"] { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.65rem; }
button { font-size: 1rem; padding: 0.7rem 1rem; min-height: 44px; margin-top: 0.75rem; }
.notice { padding: 0.75rem 1rem; margin: 0 0 1rem; border-radius: 0.4rem; background: color-mix(in srgb, CanvasText 8%, Canvas); }
.note { font-size: 0.9rem; color: color-mix(in srgb, CanvasText 70%, Canvas); }
.group { margin-top: 1.5rem; }
.item { border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); padding: 0.85rem 0; }
.meta { font-size: 0.9rem; }
nav { display: flex; gap: 1rem; margin-top: 1.25rem; }
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

export function loginPageHtml(error?: string): string {
  const notice =
    error === undefined ? '' : `<p class="notice" role="alert">${escapeHtml(error)}</p>`
  return `<h1>候補一覧に入る</h1>
${notice}
<p class="note">トークンはページに埋め込みません。Cookie は HttpOnly です。</p>
<form method="post" action="/candidates/login">
  <label for="token">トークン</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required />
  <button type="submit">入る</button>
</form>`
}

function itemHtml(item: CandidatePublic): string {
  const published =
    item.publishedAt === null
      ? '公開日不明'
      : `公開日 ${escapeHtml(calendarDateInTimeZone(item.publishedAt, CANDIDATE_LIST_TIMEZONE))}`
  const discovered = `発見日 ${escapeHtml(item.discoveredAt)}`
  return `<article class="item">
  <h3>${escapeHtml(item.title)}</h3>
  <p class="meta">${escapeHtml(item.outlet)} · ${published}</p>
  <p class="meta">${discovered} · ${escapeHtml(statusLabel(item))}</p>
  <p><a href="${escapeHtml(item.canonicalUrl)}">元記事</a></p>
</article>`
}

export function candidatesPageHtml(input: {
  readonly list: CandidateListBody
  readonly csrfToken: string
  readonly notice?: CandidateNotice
}): string {
  const notice =
    input.notice === undefined
      ? ''
      : `<p class="notice" role="status">${escapeHtml(input.notice.message)}</p>`
  const groups =
    input.list.groups.length === 0
      ? '<p>まだ候補はありません。</p>'
      : input.list.groups
          .map((group) => {
            const items = group.items.map(itemHtml).join('\n')
            return `<section class="group"><h2>${escapeHtml(group.label)}</h2>${items}</section>`
          })
          .join('\n')
  const totalPages = Math.max(1, Math.ceil(input.list.total / input.list.pageSize))
  const prev =
    input.list.page > 1 ? `<a href="/candidates?page=${input.list.page - 1}">前のページ</a>` : ''
  const next =
    input.list.page < totalPages ? `<a href="/candidates?page=${input.list.page + 1}">次のページ</a>` : ''
  return `<h1>読書候補</h1>
${notice}
<p class="note">${escapeHtml(input.list.timezoneNote ?? CANDIDATE_TIMEZONE_NOTE)}</p>
<form method="post" action="/candidates">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  <label for="url">記事 URL</label>
  <input id="url" name="url" type="url" inputmode="url" autocomplete="url" required placeholder="https://" />
  <button type="submit">候補に追加</button>
</form>
${groups}
<nav>${prev}${next}</nav>
<form method="post" action="/candidates/logout">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  <button type="submit">出る</button>
</form>`
}

export function toRegisterJson(result: {
  readonly candidate: CandidatePublic
  readonly duplicate: boolean
  readonly notice: CandidateNotice
}): {
  readonly id: CandidatePublic['id']
  readonly duplicate: boolean
  readonly candidate: CandidatePublic
  readonly notice: CandidateNotice
} {
  return {
    id: result.candidate.id,
    duplicate: result.duplicate,
    candidate: result.candidate,
    notice: result.notice,
  }
}
