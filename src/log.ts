import type { ArticleId, CandidateId, ClipJobId, ClipRunId, PipelineLog, PipelineLogContext } from './types'

export function pipelineLogFields(
  ctx: PipelineLogContext | undefined,
): Partial<PipelineLogContext> {
  if (ctx === undefined) {
    return {}
  }
  return {
    jobId: ctx.jobId,
    ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
    ...(ctx.attempt === undefined ? {} : { attempt: ctx.attempt }),
  }
}

export function logPipeline(entry: PipelineLog, ctx?: PipelineLogContext): void {
  console.log(JSON.stringify({ event: 'pipeline', ...pipelineLogFields(ctx), ...entry }))
}

export type CandidateClipLog = {
  readonly event: 'candidate_clip'
  readonly action: 'select' | 'reuse' | 'regenerate'
  readonly candidateId: CandidateId
  readonly jobId: ClipJobId
  readonly runId?: ClipRunId
  readonly articleId?: ArticleId
  readonly selectedAt: string
  readonly discoveredAt: string
  readonly publishedAt: string | null
  readonly reused: boolean
  readonly regenerated: boolean
}

export type OpdsDownloadLog = {
  readonly event: 'opds_download'
  readonly articleId: ArticleId
  readonly durationMs: number
}

export function logCandidateClip(entry: Omit<CandidateClipLog, 'event'>): void {
  console.log(JSON.stringify({ event: 'candidate_clip', ...entry } satisfies CandidateClipLog))
}

export function logOpdsDownload(entry: Omit<OpdsDownloadLog, 'event'>): void {
  console.log(JSON.stringify({ event: 'opds_download', ...entry } satisfies OpdsDownloadLog))
}

export type CandidateRecommendLog = {
  readonly event: 'candidate_recommend'
  readonly candidateId: CandidateId
  readonly status: string
  readonly grade: string | null
  readonly version: string | null
  readonly durationMs: number
  readonly inputTokens: number | null
  readonly reused: boolean
  readonly errorCode: string | null
}

export function logCandidateRecommend(entry: Omit<CandidateRecommendLog, 'event'>): void {
  console.log(JSON.stringify({ event: 'candidate_recommend', ...entry } satisfies CandidateRecommendLog))
}

export type FeedLog = {
  readonly stage: 'collect'
  readonly durationMs: number
  readonly errorKind?: string
  readonly sourceId?: string
  readonly runId?: string
  readonly attempt?: number
}

export function logFeed(entry: FeedLog): void {
  console.log(JSON.stringify({ event: 'feed', ...entry }))
}
