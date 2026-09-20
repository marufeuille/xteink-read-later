import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { EvaluateSystemOne, JevDeps, PrChangedFile, PrRiskClassifyRequest, PrRiskJudgment } from '../types/index.ts'
import { classifyPrRisk } from './classify.ts'
import { judgmentJson } from './comment.ts'
import { PR_RISK_JUDGMENT_FILENAME } from './constants.ts'
import { collectGitChangedFiles } from './git.ts'
import {
  createGitHubIssueCommentApi,
  fetchPullSnapshot,
  listMergedPullNumbers,
  parseRepository,
  pullRequestFromEvent,
  upsertPrRiskComment,
} from './github.ts'
import { classifyRequestFromPull } from './input.ts'
import { trialSummary } from './replay.ts'

const execFileAsync = promisify(execFile)

export const PR_RISK_USAGE = `使い方:
  npm run pr-risk:github [-- --no-comment] [--output pr-risk-judgment.json]
  npm run pr-risk:replay -- [--limit 20] [--pr 31,35]

github は pull_request の判定を記録するだけ。マージは変えない。
replay は過去 PR を同じルールで判定し、JSONL と見逃し集計を出す。

環境変数:
  OPENROUTER_API_KEY  Jev（OpenRouter）。未設定なら jev_skipped で追加レビュー
  GITHUB_TOKEN        PR コメント（github）または過去 PR 取得（replay）
  GITHUB_EVENT_PATH   pull_request イベント JSON
  GITHUB_REPOSITORY   owner/repo`

export type PrRiskCliIo = {
  readonly argv: readonly string[]
  readonly env: NodeJS.Dict<string>
  readonly stdout: { write(chunk: string): void }
  readonly stderr: { write(chunk: string): void }
  readonly readFile: (path: string) => Promise<string>
  readonly writeFile: (path: string, contents: string) => Promise<void>
  readonly execGit: (args: readonly string[]) => Promise<string>
  readonly fetch: typeof fetch
  readonly now: () => Date
  readonly evaluate?: EvaluateSystemOne
}

type GithubCommand = {
  readonly command: 'github'
  readonly noComment: boolean
  readonly output: string
}

type ReplayCommand = {
  readonly command: 'replay'
  readonly limit: number
  readonly prs: readonly number[]
}

type ParsedArgs = GithubCommand | ReplayCommand | { readonly error: string }

function jevDeps(env: NodeJS.Dict<string>): JevDeps {
  return { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? '' }
}

function classify(io: PrRiskCliIo, request: PrRiskClassifyRequest): Promise<PrRiskJudgment> {
  return classifyPrRisk(request, jevDeps(io.env), io.evaluate)
}

function writeError(io: PrRiskCliIo, message: string): 1 {
  io.stderr.write(`${message}\n`)
  return 1
}

function positiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null
}

function parseGithubArgs(rest: readonly string[]): GithubCommand | { readonly error: string } {
  let noComment = false
  let output = PR_RISK_JUDGMENT_FILENAME
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--no-comment') {
      noComment = true
      continue
    }
    if (arg === '--output') {
      const value = rest[index + 1]
      if (value === undefined) {
        return { error: '--output の値がありません' }
      }
      output = value
      index += 1
      continue
    }
    return { error: `不明なオプション: ${arg}` }
  }
  return { command: 'github', noComment, output }
}

function parseReplayArgs(rest: readonly string[]): ReplayCommand | { readonly error: string } {
  let limit = 20
  let prs: number[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--limit') {
      const value = rest[index + 1]
      const parsed = value === undefined ? null : positiveInt(value)
      if (parsed === null) {
        return { error: '--limit は 1 以上の整数です' }
      }
      limit = parsed
      index += 1
      continue
    }
    if (arg === '--pr') {
      const value = rest[index + 1]
      if (value === undefined) {
        return { error: '--pr の値がありません' }
      }
      prs = value.split(',').flatMap((part) => {
        const parsed = positiveInt(part)
        return parsed === null ? [] : [parsed]
      })
      if (prs.length === 0) {
        return { error: '--pr はカンマ区切りの PR 番号です' }
      }
      index += 1
      continue
    }
    return { error: `不明なオプション: ${arg}` }
  }
  return { command: 'replay', limit, prs }
}

export function parsePrRiskArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === 'help') {
    return { error: PR_RISK_USAGE }
  }
  if (command === 'github') {
    return parseGithubArgs(rest)
  }
  if (command === 'replay') {
    return parseReplayArgs(rest)
  }
  return { error: PR_RISK_USAGE }
}

async function runGithub(io: PrRiskCliIo, args: GithubCommand): Promise<number> {
  const eventPath = io.env.GITHUB_EVENT_PATH
  const repository = parseRepository(io.env.GITHUB_REPOSITORY)
  if (eventPath === undefined || eventPath.trim().length === 0) {
    return writeError(io, 'GITHUB_EVENT_PATH がありません')
  }
  if (repository === null) {
    return writeError(io, 'GITHUB_REPOSITORY が owner/repo ではありません')
  }
  let payload: unknown
  try {
    payload = JSON.parse(await io.readFile(eventPath)) as unknown
  } catch {
    return writeError(io, 'GitHub event JSON を読めません')
  }
  const pullRequest = pullRequestFromEvent(payload)
  if ('error' in pullRequest) {
    return writeError(io, pullRequest.error)
  }
  let changed: { readonly files: readonly PrChangedFile[]; readonly diff: string | null }
  try {
    changed = await collectGitChangedFiles(pullRequest.baseSha, pullRequest.headSha, io.execGit)
  } catch {
    changed = { files: [], diff: null }
  }
  const judgment = await classify(
    io,
    classifyRequestFromPull(
      pullRequest,
      changed.files,
      changed.diff,
      io.now().toISOString(),
      [pullRequest.headRef],
    ),
  )
  await io.writeFile(args.output, judgmentJson(judgment))
  io.stdout.write(
    `${judgment.recommendedRoute} sha=${judgment.headSha} blockers=${judgment.blockers.join(',') || '(none)'}\n`,
  )
  if (args.noComment) {
    return 0
  }
  const token = io.env.GITHUB_TOKEN?.trim() ?? ''
  if (token.length === 0) {
    io.stderr.write('GITHUB_TOKEN がないのでコメントは省略します\n')
    return 0
  }
  const action = await upsertPrRiskComment(
    createGitHubIssueCommentApi(token, io.fetch),
    repository.owner,
    repository.repo,
    pullRequest.number,
    judgment,
  )
  io.stdout.write(`comment ${action}\n`)
  return 0
}

async function runReplay(io: PrRiskCliIo, args: ReplayCommand): Promise<number> {
  const repository = parseRepository(io.env.GITHUB_REPOSITORY ?? 'marufeuille/xteink-read-later')
  const token = io.env.GITHUB_TOKEN?.trim() ?? io.env.GH_TOKEN?.trim() ?? ''
  if (repository === null) {
    return writeError(io, 'GITHUB_REPOSITORY が owner/repo ではありません')
  }
  if (token.length === 0) {
    return writeError(io, 'GITHUB_TOKEN または GH_TOKEN が必要です')
  }
  const numbers =
    args.prs.length > 0
      ? args.prs
      : await listMergedPullNumbers(io.fetch, token, repository.owner, repository.repo, args.limit)
  const judgments: PrRiskJudgment[] = []
  for (const number of numbers) {
    const loaded = await fetchPullSnapshot(io.fetch, token, repository.owner, repository.repo, number)
    const judgment = await classify(
      io,
      classifyRequestFromPull(loaded.pull, loaded.files, loaded.diff, io.now().toISOString(), [], loaded.filesIncomplete),
    )
    judgments.push(judgment)
    io.stdout.write(`${JSON.stringify(judgment)}\n`)
  }
  const summary = trialSummary(judgments)
  io.stderr.write(
    `total=${summary.total} additional_review=${summary.additionalReview} low_risk=${summary.lowRisk} hard_rule=${summary.hardRule} hard_rule_misses=${summary.hardRuleMisses} jev_skipped=${summary.jevSkipped}\n`,
  )
  return 0
}

export async function runPrRiskCli(io: PrRiskCliIo): Promise<number> {
  const args = parsePrRiskArgs(io.argv)
  if ('error' in args) {
    return writeError(io, args.error)
  }
  try {
    return args.command === 'github' ? await runGithub(io, args) : await runReplay(io, args)
  } catch (cause) {
    return writeError(io, cause instanceof Error ? cause.message : String(cause))
  }
}

export function defaultPrRiskCliIo(overrides: Partial<PrRiskCliIo> = {}): PrRiskCliIo {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
    execGit: async (args) => {
      const { stdout } = await execFileAsync('git', [...args], { maxBuffer: 20_000_000 })
      return stdout
    },
    fetch,
    now: () => new Date(),
    ...overrides,
  }
}

async function main(): Promise<void> {
  process.exitCode = await runPrRiskCli(defaultPrRiskCliIo())
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main()
}
