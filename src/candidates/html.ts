import { RECOMMEND_GRADE_LABELS, RECOMMEND_REASON_LABELS, recommendDisplayLabel } from '../recommend/taxonomy'
import {
  CANDIDATE_LIST_TIMEZONE,
  type CandidateListBody,
  type CandidateListFilters,
  type CandidateNotice,
  type CandidatePublic,
} from '../types'
import { candidateCanRegenerate, candidateCanSend } from './delivery'
import {
  candidateListFiltersActive,
  candidatesReturnToQuery,
  formatCandidatesPath,
} from './list-filter'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function deliveryErrorLabel(item: CandidatePublic): string {
  const code = item.deliveryError?.code
  switch (code) {
    case 'queue_failed':
      return 'Queue への送信に失敗しました'
    case 'fetch_failed':
      return '本文の取得に失敗しました'
    case 'extract_failed':
      return '本文を抽出できませんでした'
    case 'translate_failed':
      return '翻訳に失敗しました'
    case 'epub_failed':
      return 'EPUB の生成に失敗しました'
    case 'internal_error':
      return '準備が中断されました'
    default:
      return item.deliveryError?.message ?? '失敗'
  }
}

function deliveryLabel(item: CandidatePublic): string {
  switch (item.deliveryState) {
    case 'unsent':
      return '未送信'
    case 'preparing':
      return '準備中'
    case 'available':
      return 'OPDSで取得可能'
    case 'failed':
      return `失敗: ${deliveryErrorLabel(item)}`
  }
}

function statusLabel(item: CandidatePublic): string {
  if (item.fetchStatus === 'fetch_failed') {
    return '取得失敗'
  }
  return deliveryLabel(item)
}

const STYLES = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 1rem; max-width: 46rem; line-height: 1.45; }
h1 { font-size: 1.25rem; margin-bottom: 0.75rem; }
label { display: block; margin: 0.75rem 0 0.35rem; }
input[type="url"], input[type="search"], select {
  width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.55rem;
}
button { font-size: 1rem; padding: 0.7rem 1rem; min-height: 44px; margin-top: 0.75rem; margin-right: 0.5rem; }
.notice { padding: 0.75rem 1rem; margin: 0 0 1rem; border-radius: 0.4rem; background: color-mix(in srgb, CanvasText 8%, Canvas); }
.note { font-size: 0.9rem; color: color-mix(in srgb, CanvasText 70%, Canvas); }
.login { max-width: 40rem; }
.add {
  display: flex;
  gap: 0.5rem;
  align-items: end;
  margin: 0.75rem 0 0;
}
.add label { flex: 1; margin: 0; }
.add button { margin: 0; white-space: nowrap; }
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.65rem 1rem;
  align-items: end;
  margin: 1rem 0;
}
.filters label { margin: 0; }
.filters button { margin: 0; }
.about { margin: 0 0 0.5rem; }
.about summary { cursor: pointer; }
.day { margin-top: 1.1rem; }
.day h2 {
  position: sticky;
  top: 0;
  margin: 0;
  padding: 0.4rem 0;
  font-size: 0.8rem;
  font-weight: 650;
  letter-spacing: 0.01em;
  background: Canvas;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 22%, Canvas);
}
.item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.35rem 0.75rem;
  align-items: start;
  padding: 0.7rem 0;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, Canvas);
}
.title { font-weight: 650; text-decoration: none; }
.title:hover { text-decoration: underline; }
.meta { margin: 0.2rem 0 0; font-size: 0.85rem; color: color-mix(in srgb, CanvasText 70%, Canvas); }
.actions { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; justify-content: flex-end; }
.actions form { margin: 0; }
.actions button { margin: 0; min-height: 36px; padding: 0.3rem 0.55rem; font-size: 0.85rem; }
nav { display: flex; gap: 1rem; margin-top: 1.25rem; flex-wrap: wrap; }
@media (max-width: 40rem) {
  .add { flex-direction: column; align-items: stretch; }
  .item { grid-template-columns: minmax(0, 1fr); }
  .actions { justify-content: flex-start; }
}
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

export function accessRequiredHtml(): string {
  return `<div class="login"><h1>Google アカウントで入る</h1>
<p class="note">Cloudflare Access が Google 認証します。トークンは使いません。認証後にこのページを開き直してください。</p>
<p class="note"><a href="/candidates">候補一覧</a> · <a href="/sources">情報源</a></p></div>`
}

function recommendReasonsLabel(item: CandidatePublic): string {
  if (item.recommendation.reasons.length === 0) {
    return ''
  }
  return item.recommendation.reasons.map((reason) => RECOMMEND_REASON_LABELS[reason]).join(' · ')
}

function candidateActionForm(
  item: CandidatePublic,
  csrfToken: string,
  action: 'clip' | 'recommend',
  flag: 'force' | 'regenerate' | null,
  label: string,
  returnTo: string,
): string {
  const extra = flag === null ? '' : `<input type="hidden" name="${flag}" value="1" />`
  const returnField =
    returnTo === '' ? '' : `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />`
  return `<form method="post" action="/candidates/${escapeHtml(item.id)}/${action}">
  <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
  ${returnField}
  ${extra}
  <button type="submit">${escapeHtml(label)}</button>
</form>`
}

function actionsBlock(buttons: readonly string[]): string {
  return buttons.length === 0 ? '' : `<div class="actions">${buttons.join('')}</div>`
}

function itemActions(item: CandidatePublic, csrfToken: string, returnTo: string): string {
  const buttons: string[] = []
  const judged =
    item.recommendation.status === 'evaluated' || item.recommendation.status === 'low_confidence'
  if (item.exclusionReason !== 'paywalled') {
    buttons.push(
      candidateActionForm(
        item,
        csrfToken,
        'recommend',
        judged ? 'force' : null,
        judged ? '再判定' : '判定する',
        returnTo,
      ),
    )
  }
  if (item.fetchStatus === 'fetch_failed' && item.deliveryState === 'unsent') {
    return `${actionsBlock(buttons)}<p class="note">ページを取得できていないため、全文は送れません</p>`
  }
  if (item.deliveryState === 'preparing') {
    return `${actionsBlock(buttons)}<p class="note">準備中です</p>`
  }
  if (candidateCanSend(item) && item.deliveryState === 'unsent') {
    buttons.push(candidateActionForm(item, csrfToken, 'clip', null, '全文を送る', returnTo))
  }
  if (candidateCanSend(item) && item.deliveryState === 'failed') {
    buttons.push(candidateActionForm(item, csrfToken, 'clip', null, '再試行', returnTo))
  }
  if (candidateCanRegenerate(item)) {
    buttons.push(candidateActionForm(item, csrfToken, 'clip', 'regenerate', '再生成', returnTo))
  }
  return actionsBlock(buttons)
}

function itemCard(item: CandidatePublic, csrfToken: string, returnTo: string): string {
  const reasons = recommendReasonsLabel(item)
  const meta = [
    item.outlet,
    recommendDisplayLabel(item.recommendation),
    ...(reasons === '' ? [] : [reasons]),
    statusLabel(item),
  ].join(' · ')
  return `<article class="item">
  <div>
    <a class="title" href="${escapeHtml(item.canonicalUrl)}" rel="noreferrer">${escapeHtml(item.title)}</a>
    <p class="meta">${escapeHtml(meta)}</p>
  </div>
  ${itemActions(item, csrfToken, returnTo)}
</article>`
}

function dayHeading(date: string | null, label: string): string {
  if (date === null) {
    return label
  }
  const weekday = new Intl.DateTimeFormat('ja-JP', {
    timeZone: CANDIDATE_LIST_TIMEZONE,
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00+09:00`))
  return `${date}（${weekday}）`
}

const GRADE_FILTER_OPTIONS: ReadonlyArray<{ value: CandidateListFilters['grade']; label: string }> = [
  { value: '', label: 'すべて' },
  { value: 'recommended', label: RECOMMEND_GRADE_LABELS.recommended },
  { value: 'related', label: RECOMMEND_GRADE_LABELS.related },
  { value: 'low_priority', label: RECOMMEND_GRADE_LABELS.low_priority },
  { value: 'pending', label: '未判定など' },
]

function htmlOption(value: string, label: string, selected: string): string {
  const isSelected = value === selected ? ' selected' : ''
  return `<option value="${escapeHtml(value)}"${isSelected}>${escapeHtml(label)}</option>`
}

function gradeOptions(selected: CandidateListFilters['grade']): string {
  return GRADE_FILTER_OPTIONS.map((option) => htmlOption(option.value, option.label, selected)).join('')
}

function outletOptions(outlets: readonly string[], selected: string): string {
  const values = selected !== '' && !outlets.includes(selected) ? [selected, ...outlets] : outlets
  return `${htmlOption('', 'すべて', selected)}${values.map((outlet) => htmlOption(outlet, outlet, selected)).join('')}`
}

function filterForm(list: CandidateListBody): string {
  const filters = list.filters
  return `<form class="filters" method="get" action="/candidates" role="search">
  <label for="title">タイトル
    <input id="title" name="title" type="search" value="${escapeHtml(filters.title)}" />
  </label>
  <label for="grade">おすすめ度
    <select id="grade" name="grade">${gradeOptions(filters.grade)}</select>
  </label>
  <label for="outlet">ソース
    <select id="outlet" name="outlet">${outletOptions(list.outlets, filters.outlet)}</select>
  </label>
  <button type="submit">絞り込む</button>
</form>`
}

function rangeLabel(list: CandidateListBody): string {
  if (list.total === 0) {
    return candidateListFiltersActive(list.filters) ? '条件に一致する候補はありません。' : 'まだ候補はありません。'
  }
  const start = (list.page - 1) * list.pageSize + 1
  if (start > list.total) {
    return `${list.total}件（このページは範囲外です）`
  }
  const end = Math.min(list.total, list.page * list.pageSize)
  return `${list.total}件中 ${start}–${end}件`
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
  const groups = input.list.groups
  const items = groups.flatMap((group) => group.items)
  const preparing = items.some((item) => item.deliveryState === 'preparing')
  const returnTo = candidatesReturnToQuery(input.list.filters, input.list.page)
  const listPath = formatCandidatesPath(input.list.filters, input.list.page)
  const list =
    items.length === 0
      ? `<p>${escapeHtml(rangeLabel(input.list))}</p>`
      : `<p class="note">${escapeHtml(rangeLabel(input.list))} · 公開日の新しい順</p>
${groups
  .map((group) => {
    const cards = group.items.map((item) => itemCard(item, input.csrfToken, returnTo)).join('\n')
    return `<section class="day"><h2>${escapeHtml(dayHeading(group.date, group.label))}</h2>${cards}</section>`
  })
  .join('\n')}`
  const totalPages = Math.max(1, Math.ceil(input.list.total / input.list.pageSize))
  const prev =
    input.list.page > 1
      ? `<a href="${escapeHtml(formatCandidatesPath(input.list.filters, input.list.page - 1))}">前のページ</a>`
      : ''
  const next =
    input.list.page < totalPages
      ? `<a href="${escapeHtml(formatCandidatesPath(input.list.filters, input.list.page + 1))}">次のページ</a>`
      : ''
  const refresh = preparing
    ? `<p class="note"><a href="${escapeHtml(listPath)}">表示を更新</a>（準備中は完了後に OPDSで取得可能になります）</p>`
    : ''
  return `<h1>読書候補</h1>
${notice}
<nav><a href="/sources">情報源</a></nav>
<form class="add" method="post" action="/candidates">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
  ${returnTo === '' ? '' : `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />`}
  <label for="url">記事 URL
    <input id="url" name="url" type="url" inputmode="url" autocomplete="url" required placeholder="https://" />
  </label>
  <button type="submit">候補に追加</button>
</form>
${filterForm(input.list)}
<details class="about">
  <summary>一覧の見方</summary>
  <p class="note">${escapeHtml(input.list.timezoneNote)}</p>
  <p class="note">「OPDSで取得可能」はカタログに載った状態です。端末のダウンロード済みや読了ではありません。</p>
  <p class="note">おすすめ度はデータエンジニア視点の読書補助です。品質の保証ではありません。未判定・材料不足・低確信・失敗は低評価ではありません。</p>
</details>
${refresh}
${list}
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
