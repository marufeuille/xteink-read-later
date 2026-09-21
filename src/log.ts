import type { PipelineLog, PipelineLogContext } from './types'

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
