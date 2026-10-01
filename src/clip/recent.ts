import { formatCollectedAtJst } from '../feeds/html'
import type { ClipJobRecord, ClipJobStatus, ErrorKind, PipelineStage } from '../types'

/** Newest jobs shown on the Access-protected recent clips page. */
export const RECENT_CLIP_LIMIT = 40

export type RecentClip = {
  readonly jobId: ClipJobRecord['jobId']
  readonly status: ClipJobStatus
  readonly stage: PipelineStage | null
  /** Stored instant. Omitted when it cannot be shown in Asia/Tokyo. */
  readonly updatedAt?: string
  readonly error?: {
    readonly code: ErrorKind
  }
}

export function recentClipLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0
  }
  return Math.min(Math.floor(limit), 100)
}

export function compareRecentJobs(a: ClipJobRecord, b: ClipJobRecord): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? 1 : -1
  }
  if (a.jobId === b.jobId) {
    return 0
  }
  return a.jobId < b.jobId ? -1 : 1
}

/** Stored instant when Asia/Tokyo can render it. Otherwise omit it instead of inventing a time. */
function visibleUpdatedAt(value: string): string | undefined {
  if (formatCollectedAtJst(value) === null) {
    return undefined
  }
  return value
}

/** Fields safe to show. Omits URL, body, token, and error.message. */
export function toRecentClip(job: ClipJobRecord): RecentClip {
  const latest = job.stages.at(-1)
  const stage = latest === undefined ? null : latest.stage
  const updatedAt = visibleUpdatedAt(job.updatedAt)
  const time = updatedAt === undefined ? {} : { updatedAt }
  if (job.status === 'failed') {
    return {
      jobId: job.jobId,
      status: job.status,
      stage,
      ...time,
      error: { code: job.error.code },
    }
  }
  return {
    jobId: job.jobId,
    status: job.status,
    stage,
    ...time,
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Shown on the recent-clips HTML page as ラベル（code）.
 * Words match `inferDisplayStatus` for these four codes. CLI-only running
 * sub-states (工程不明 / 再試行待ち) are not used here.
 */
const STATUS_LABELS = {
  queued: '待機中',
  running: '処理中',
  ready: '完了',
  failed: '失敗',
} as const satisfies Record<ClipJobStatus, string>

/** Shown on the recent-clips HTML page as ラベル（code）. */
const STAGE_LABELS = {
  queue: 'キュー',
  fetch: '本文取得',
  extract: '本文抽出',
  translate: '翻訳',
  epub: 'EPUB生成',
  store: '保存',
  classify: '分類',
} as const satisfies Record<PipelineStage, string>

/** Clip-job error codes only. Other ErrorKind values stay as the raw code. */
const ERROR_CODE_LABELS = {
  invalid_url: '不正なURL',
  payload_too_large: 'サイズ超過',
  fetch_failed: '本文取得',
  extract_failed: '本文抽出',
  translate_failed: '翻訳',
  epub_failed: 'EPUB生成',
  queue_failed: 'キュー',
  internal_error: '内部エラー',
} as const satisfies Partial<Record<ErrorKind, string>>

function labeledCode(code: string, labels: object): string {
  if (!Object.hasOwn(labels, code)) {
    return code
  }
  const label = (labels as Record<string, unknown>)[code]
  if (typeof label !== 'string' || label.length === 0) {
    return code
  }
  return `${label}（${code}）`
}

function stageLabel(stage: string | null): string {
  if (stage === null) {
    return 'なし'
  }
  return labeledCode(stage, STAGE_LABELS)
}

function statusLabel(status: string): string {
  return labeledCode(status, STATUS_LABELS)
}

const RECENT_STYLES = `<style>
  .fail-banner, .clip-failed {
    background: #9b1c1c;
    color: #fff;
  }
  .fail-banner {
    padding: 0.8rem 1rem;
    border-radius: 0.4rem;
    font-weight: 700;
    margin: 0 0 1rem;
  }
  .clip-failed {
    border: 3px solid #5c0a0a;
    border-radius: 0.4rem;
    padding: 0.8rem 1rem;
    margin: 0.8rem 0;
    font-weight: 700;
  }
  .fail-badge {
    display: inline-block;
    background: #fff;
    color: #9b1c1c;
    font-weight: 700;
    padding: 0.1rem 0.45rem;
    border-radius: 0.25rem;
  }
  .clip-row {
    padding: 0.7rem 0;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
  }
  .reclip-hint {
    font-weight: 500;
    font-size: 0.9rem;
    margin: 0.6rem 0 0;
  }
</style>`

function updatedAtLine(updatedAt: string | undefined): string {
  if (updatedAt === undefined) {
    return ''
  }
  const formatted = formatCollectedAtJst(updatedAt)
  if (formatted === null) {
    return ''
  }
  return `<p>更新: ${escapeHtml(formatted)} JST</p>`
}

function recentClipRow(job: RecentClip): string {
  const failed = job.status === 'failed'
  const error =
    job.error === undefined
      ? ''
      : `<p>error.code: ${escapeHtml(labeledCode(job.error.code, ERROR_CODE_LABELS))}</p>`
  const badge = failed ? '<p><span class="fail-badge">失敗</span></p>' : ''
  const hint = failed
    ? '<p class="reclip-hint">再クリップは Shortcuts で同じ記事を送り直す。</p>'
    : ''
  const updated = updatedAtLine(job.updatedAt)
  const articleClass = failed ? 'clip-failed' : 'clip-row'
  const alert = failed ? ' role="alert"' : ''
  return `<article class="${articleClass}" data-status="${escapeHtml(job.status)}"${alert}>
  ${badge}
  <p>jobId: ${escapeHtml(job.jobId)}</p>
  <p>status: ${escapeHtml(statusLabel(job.status))}</p>
  <p>stage: ${escapeHtml(stageLabel(job.stage))}</p>
  ${updated}
  ${error}
  ${hint}
</article>`
}

export function recentClipsHtml(jobs: readonly RecentClip[]): string {
  const failedCount = jobs.filter((job) => job.status === 'failed').length
  const banner =
    failedCount === 0
      ? ''
      : `<p class="fail-banner" role="alert">失敗が ${String(failedCount)} 件あります。</p>`
  const rows =
    jobs.length === 0
      ? '<p>最近のクリップはまだありません。</p>'
      : jobs.map((job) => recentClipRow(job)).join('\n')
  return `${RECENT_STYLES}
<h1>最近のクリップ</h1>
<p class="note">完了と失敗をここで確認します。Shortcuts で短時間ポーリングしなくても、このページを開けば分かります。</p>
<p><a href="/clip/recent">更新</a> · <a href="/clip/web">記事をクリップ</a></p>
${banner}
${rows}`
}
