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
