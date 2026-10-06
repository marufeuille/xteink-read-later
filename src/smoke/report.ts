import { appendFileSync } from 'node:fs'
import { articleUnreachableSummary, isArticleReachabilityKind } from './preflight.ts'
import type { SmokeRunResult, SmokeStateFile } from './run.ts'
import { publishUnsetSkip } from './unset.ts'

export function isArticlePreflightUnreachable(state: SmokeStateFile): boolean {
  return (
    state.outcome === 'failed' &&
    state.failedStep === 'article-preflight' &&
    state.errorKind !== null &&
    isArticleReachabilityKind(state.errorKind)
  )
}

/**
 * Exit code for the deploy-smoke run step.
 * `SMOKE_REQUIRED` fails the job only for an unset skip. An unreachable article is always exit 1.
 */
export function recordDeploySmokeResult(input: {
  readonly result: SmokeRunResult
  readonly smokeRequired: string | undefined
  readonly summaryPath?: string
  readonly warn?: (line: string) => void
}): number {
  if (input.result.kind === 'skipped') {
    return publishUnsetSkip({
      missing: input.result.missing,
      smokeRequired: input.smokeRequired,
      ...(input.summaryPath === undefined ? {} : { summaryPath: input.summaryPath }),
      ...(input.warn === undefined ? {} : { warn: input.warn }),
    })
  }
  if (input.result.kind === 'failed') {
    const errorKind = input.result.state.errorKind
    const summaryPath = input.summaryPath?.trim() ?? ''
    if (isArticlePreflightUnreachable(input.result.state) && summaryPath.length > 0 && errorKind !== null) {
      appendFileSync(summaryPath, articleUnreachableSummary(errorKind))
    }
    return 1
  }
  return 0
}
