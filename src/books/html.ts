function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function visibleText(value: string, secret: string | undefined): string {
  if (secret !== undefined && secret.length > 0 && value.includes(secret)) {
    return '（秘密値を含むため表示しません）'
  }
  return value
}

const FIELD_STYLE = `<style>
  input[type="text"], input[type="file"] { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.55rem; }
</style>`

export function booksFormHtml(csrfToken: string): string {
  return `${FIELD_STYLE}
<h1>購入した EPUB を載せる</h1>
<p class="note">翻訳・整形・本文の改変はしません。書店からは取りません。成功すると OPDS の ebook 棚に出ます。</p>
<form method="post" action="/books" enctype="multipart/form-data">
  <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
  <label for="epub">EPUB</label>
  <input id="epub" name="epub" type="file" accept="application/epub+zip,.epub" required />
  <label for="title">タイトル</label>
  <input id="title" name="title" type="text" autocomplete="off" />
  <p class="note">空なら本の中の dc:title を使います。</p>
  <label for="author">著者（任意）</label>
  <input id="author" name="author" type="text" autocomplete="off" />
  <p class="note">空なら本の中の dc:creator を使います。無くても載せられます。</p>
  <button type="submit">載せる</button>
</form>
<nav><a href="/candidates">候補一覧</a></nav>`
}

export function booksResultHtml(input: {
  readonly title: string
  readonly author: string | null
  readonly secret?: string
}): string {
  const author =
    input.author === null
      ? ''
      : `<p>著者: ${escapeHtml(visibleText(input.author, input.secret))}</p>`
  return `<h1>購入本を載せました</h1>
<p class="notice" role="status">OPDS の ebook 棚に出ます。</p>
<p>タイトル: ${escapeHtml(visibleText(input.title, input.secret))}</p>
${author}
<p class="note">翻訳・整形・本文の改変はしていません。同じファイルを再送すると上書きします。</p>
<p><a href="/books">別の EPUB を載せる</a></p>`
}

export function booksErrorHtml(kind: 'invalid_epub' | 'payload_too_large'): string {
  const message =
    kind === 'payload_too_large'
      ? 'ファイルが上限を超えています。受け付けていません。'
      : 'EPUB を読み取れませんでした。タイトルが空のときは本の dc:title が必要です。'
  return `<h1>載せられませんでした</h1>
<p>${message}</p>
<p><a href="/books">戻る</a></p>`
}
