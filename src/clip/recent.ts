import type { ClipJobRecord, ClipJobStatus, ErrorKind, PipelineStage } from '../types'

/** Newest jobs shown on the Access-protected recent clips page. */
export const RECENT_CLIP_LIMIT = 40

export type RecentClip = {
  readonly jobId: ClipJobRecord['jobId']
  readonly status: ClipJobStatus
  readonly stage: PipelineStage | null
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

/** Fields safe to show. Omits URL, body, token, and error.message. */
export function toRecentClip(job: ClipJobRecord): RecentClip {
  const latest = job.stages.at(-1)
  const stage = latest === undefined ? null : latest.stage
  if (job.status === 'failed') {
    return {
      jobId: job.jobId,
      status: job.status,
      stage,
      error: { code: job.error.code },
    }
  }
  return {
    jobId: job.jobId,
    status: job.status,
    stage,
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

function stageLabel(stage: PipelineStage | null): string {
  return stage ?? 'なし'
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
  .reclip {
    font-weight: 400;
    margin: 0.7rem 0 0;
  }
</style>`

/** Under each failed row. Names the re-clip step without a URL or article body. */
const RECLIP_NOTE = '再クリップは Shortcuts で同じ記事を送り直す。jobId は上に表示。'

function recentClipRow(job: RecentClip): string {
  const failed = job.status === 'failed'
  const error =
    job.error === undefined ? '' : `<p>error.code: ${escapeHtml(job.error.code)}</p>`
  const badge = failed ? '<p><span class="fail-badge">失敗</span></p>' : ''
  const reclip = failed ? `<p class="reclip">${RECLIP_NOTE}</p>` : ''
  const articleClass = failed ? 'clip-failed' : 'clip-row'
  const alert = failed ? ' role="alert"' : ''
  return `<article class="${articleClass}" data-status="${escapeHtml(job.status)}"${alert}>
  ${badge}
  <p>jobId: ${escapeHtml(job.jobId)}</p>
  <p>status: ${escapeHtml(job.status)}</p>
  <p>stage: ${escapeHtml(stageLabel(job.stage))}</p>
  ${error}
  ${reclip}
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
