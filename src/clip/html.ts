function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function clipWebUrlPreview(raw: string, secret: string | undefined): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed === '') {
    return ''
  }
  if (secret !== undefined && secret.length > 0 && trimmed.includes(secret)) {
    return ''
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed
}

export function clipWebUrlContainsSecret(url: string, secret: string | undefined): boolean {
  return secret !== undefined && secret.length > 0 && url.includes(secret)
}

export function clipWebMissingHtml(bookmarklet: string): string {
  return `<h1>記事をクリップ</h1>
<p>今開いているタブから送るには、次の文字列をブックマークの URL に登録します。トークンは入っていません。</p>
<textarea readonly rows="4" style="width:100%;box-sizing:border-box">${escapeHtml(bookmarklet)}</textarea>
<p class="note">記事のタブでそのブックマークを開くと、URL を確認してからクリップできます。このページを開いただけでは受け付けません。</p>`
}

export function clipWebInvalidHtml(preview: string): string {
  const shown = preview === '' ? '' : `<p>${escapeHtml(preview)}</p>`
  return `<h1>URL を確認できませんでした</h1>
<p>http または https の記事 URL が必要です。受け付けていません。</p>
${shown}`
}

export function clipWebSecretHtml(): string {
  return `<h1>URL を確認できませんでした</h1>
<p>URL に秘密値が含まれているため、表示も受け付けもしません。</p>`
}

export function clipWebConfirmHtml(input: { readonly url: string; readonly csrfToken: string }): string {
  const url = escapeHtml(input.url)
  return `<h1>記事をクリップ</h1>
<p>この URL を確認してからクリップします。このページを開いただけでは受け付けません。</p>
<p><a href="${url}" rel="noreferrer">${url}</a></p>
<form method="post" action="/clip/web">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  <input type="hidden" name="url" value="${url}" />
  <button type="submit">クリップする</button>
</form>`
}

export function clipWebResultHtml(input: {
  readonly kind: 'queued' | 'active' | 'failed'
  readonly jobId?: string
}): string {
  if (input.kind === 'failed') {
    return `<h1>送れませんでした</h1>
<p>Queue への送信に失敗しました。同じ URL でもう一度クリップできます。</p>`
  }
  const lead =
    input.kind === 'active'
      ? 'すでに受け付け済みです。同じ jobId のまま、二重には載せません。'
      : 'クリップを受け付けました。'
  return `<h1>クリップを受け付けました</h1>
<p class="notice" role="status">${escapeHtml(lead)}</p>
<p>status: queued</p>
<p>jobId: ${escapeHtml(input.jobId ?? '')}</p>
<p class="note">本文の取得と EPUB 化は Queue が続けます。完成は OPDS の clip 棚で確認します。</p>`
}
