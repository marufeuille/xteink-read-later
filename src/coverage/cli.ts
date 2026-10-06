import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  diffCoverage,
  parseCoverageFinal,
  parseCoverageTotals,
  parseUnifiedDiff,
  renderDiffCoverageReport,
  type CoverageFinal,
  type CoverageTotals,
  type DiffCoverage,
} from './diff-report.ts'
import { changedSourceLines, readEventBefore, type DiffMode } from './git-diff.ts'

export type ReportInput = {
  readonly cwd: string
  readonly diffFile: string | null
  readonly coverageFile: string
  readonly summaryFile: string
  readonly summaryOut: string | null
  readonly vitestStatus: number | null
  readonly elapsedSeconds: number | null
  readonly eventName: string
  readonly headSha: string
  readonly baseSha: string
  readonly eventPath: string | undefined
  readonly allowFetch: boolean
}

export function buildCoverageSummary(input: ReportInput): string {
  const notes: string[] = []
  let coverage: CoverageFinal = {}
  let totals: CoverageTotals | null = null
  try {
    coverage = parseCoverageFinal(JSON.parse(readFileSync(input.coverageFile, 'utf8')))
  } catch (error) {
    notes.push(`カバレッジ結果を読めませんでした: ${errorName(error)}`)
  }
  try {
    totals = parseCoverageTotals(JSON.parse(readFileSync(input.summaryFile, 'utf8')))
    if (totals === null) notes.push('coverage-summary.json に全体の行・分岐がありません')
  } catch (error) {
    notes.push(`全体カバレッジを読めませんでした: ${errorName(error)}`)
  }
  const loaded = loadChangedLines(input)
  if (loaded.note) notes.push(loaded.note)
  const diff: DiffCoverage = diffCoverage({
    changedLines: loaded.lines,
    coverage,
    root: input.cwd,
  })
  return renderDiffCoverageReport({
    diff,
    totals,
    elapsedSeconds: input.elapsedSeconds,
    vitestStatus: input.vitestStatus,
    diffMode: loaded.mode,
    notes,
  })
}

export function publishCoverageSummary(input: ReportInput): string {
  const summary = buildCoverageSummary(input)
  if (input.summaryOut && input.summaryOut.length > 0) appendFileSync(input.summaryOut, summary)
  console.log(summary)
  return summary
}

function loadChangedLines(input: ReportInput): {
  readonly lines: ReadonlyMap<string, ReadonlySet<number>>
  readonly mode: DiffMode
  readonly note: string | null
} {
  if (input.diffFile) {
    try {
      return { lines: parseUnifiedDiff(readFileSync(input.diffFile, 'utf8')), mode: 'two-dot', note: null }
    } catch (error) {
      return { lines: new Map(), mode: 'none', note: `diff を読めませんでした: ${errorName(error)}` }
    }
  }
  return changedSourceLines({
    cwd: input.cwd,
    eventName: input.eventName,
    headSha: input.headSha,
    baseSha: input.baseSha,
    eventBefore: readEventBefore(input.eventPath, input.eventName),
    allowFetch: input.allowFetch,
  })
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : ''
    return code.length > 0 ? code : error.name
  }
  return 'Error'
}

function argument(name: string, argv: readonly string[]): string | null {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : null
}

export function readVitestStatus(argv: readonly string[]): number | null {
  const status = argument('--vitest-status', argv)
  return status !== null && /^-?\d+$/.test(status) ? Number(status) : null
}

export function formatCoverageFailure(error: unknown, vitestStatus: number | null): string {
  const status = vitestStatus === null ? '' : `vitest_exit_status=${vitestStatus}\n`
  return `### 差分カバレッジ（unit）\n\n表示に失敗しました: ${errorName(error)}\n\n${status}`
}

type CoverageCliEnv = {
  readonly [key: string]: string | undefined
}

export function reportInputFromArgv(argv: readonly string[], env: CoverageCliEnv, cwd: string): ReportInput {
  const elapsed = argument('--elapsed-seconds', argv)
  const elapsedSeconds = elapsed !== null && /^\d+$/.test(elapsed) ? Number(elapsed) : null
  return {
    cwd,
    diffFile: argument('--diff-file', argv),
    coverageFile: resolve(cwd, argument('--coverage-file', argv) ?? 'coverage/coverage-final.json'),
    summaryFile: resolve(cwd, argument('--summary-file', argv) ?? 'coverage/coverage-summary.json'),
    summaryOut: argument('--summary-out', argv) ?? env['GITHUB_STEP_SUMMARY'] ?? null,
    vitestStatus: readVitestStatus(argv),
    elapsedSeconds,
    eventName: env['EVENT_NAME'] ?? env['GITHUB_EVENT_NAME'] ?? '',
    headSha: env['HEAD_SHA'] ?? env['GITHUB_SHA'] ?? '',
    baseSha: env['BASE_SHA'] ?? '',
    eventPath: env['GITHUB_EVENT_PATH'],
    allowFetch: true,
  }
}

export function runCoverageCli(argv: readonly string[], env: CoverageCliEnv, cwd: string): number {
  const vitestStatus = readVitestStatus(argv)
  try {
    publishCoverageSummary(reportInputFromArgv(argv, env, cwd))
  } catch (error) {
    const message = formatCoverageFailure(error, vitestStatus)
    const summaryOut = env['GITHUB_STEP_SUMMARY']
    if (summaryOut && summaryOut.length > 0) appendFileSync(summaryOut, message)
    console.log(message)
  }
  return 0
}

function main(): number {
  return runCoverageCli(process.argv.slice(2), process.env, process.cwd())
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main())
}
