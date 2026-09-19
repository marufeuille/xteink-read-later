import type { PipelineLog } from './types'

export function logPipeline(entry: PipelineLog): void {
  console.log(JSON.stringify({ event: 'pipeline', ...entry }))
}
