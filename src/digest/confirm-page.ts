import type { CandidateUnsendableReason } from '../types'
import { escapeHtml } from '../feeds/html'

export function unsendableMessage(reason: CandidateUnsendableReason): string {
  switch (reason) {
    case 'paywalled':
    case 'excluded':
      return '有料または除外されているため、全文は送れません'
    case 'unavailable':
      return '全文を取得できないため送れません'
    case 'fetch_failed':
      return 'ページを取得できなかったため送れません'
  }
}

export function digestConfirmViewHtml(input: { readonly title: string; readonly action: string }): string {
  return `<h1>全文を送る</h1>
<p>「${escapeHtml(input.title)}」の全文 EPUB を端末の本棚へ送ります。</p>
<p class="note">この画面を開いただけでは送信しません。完成済みなら、ボタンを押しても新しい生成は始まりません。</p>
<form method="post" action="${escapeHtml(input.action)}">
  <button type="submit">全文を送る</button>
</form>`
}

export function digestConfirmUnsendableHtml(input: {
  readonly title: string
  readonly reason: CandidateUnsendableReason
}): string {
  return `<h1>送れません</h1>
<p>「${escapeHtml(input.title)}」</p>
<p>${escapeHtml(unsendableMessage(input.reason))}</p>`
}

export function digestConfirmResultHtml(input: {
  readonly title: string
  readonly kind: 'reused' | 'preparing' | 'queued'
}): string {
  const message =
    input.kind === 'reused'
      ? '完成済みの全文を使います。新しい生成は始めません。'
      : input.kind === 'preparing'
        ? 'すでに準備中です。新しい生成は始めません。'
        : '全文の準備を開始しました。端末のカタログを更新すると出ます。'
  return `<h1>全文を送る</h1>
<p>「${escapeHtml(input.title)}」</p>
<p>${escapeHtml(message)}</p>`
}

export function digestConfirmRejectedHtml(reason: 'invalid' | 'expired'): { readonly title: string; readonly body: string } {
  if (reason === 'expired') {
    return {
      title: '期限切れ',
      body: '<h1>期限切れ</h1><p>この QR の期限が切れています。</p>',
    }
  }
  return {
    title: '無効なリンク',
    body: '<h1>無効なリンク</h1><p>この QR は使えません。</p>',
  }
}
