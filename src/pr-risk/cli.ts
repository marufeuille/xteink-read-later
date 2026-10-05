import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { EvaluateSystemOne, JevDeps, PrChangedFile, PrRiskClassifyRequest, PrRiskJudgment } from '../types/index.ts'
import { openRouterApiKey } from '../jev/client.ts'
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
  upsertMatchingComment,
  upsertPrRiskComment,
} from './github.ts'
import { classifyRequestFromPull } from './input.ts'
import { trialSummary } from './replay.ts'
import {
  DEFAULT_REVIEW_BUDGET,
  HIGH_RISK_REVIEW_BOT_LOGIN,
  HIGH_RISK_REVIEW_FILENAME,
  HIGH_RISK_REVIEW_VARIABLE,
  executeHighRiskReview,
  formatHighRiskReviewComment,
  highRiskReviewJson,
  isHighRiskReviewComment,
  keepsEarlierReviewCall,
  reviewJudgmentFromJson,
  type HighRiskReviewRecord,
  type ReviewCallComment,
} from './review.ts'

const execFileAsync = promisify(execFile)

export const PR_RISK_USAGE = `使い方:
  npm run pr-risk:github [-- --no-comment] [--output pr-risk-judgment.json]
  npm run pr-risk:replay -- [--limit 20] [--pr 31,35]
  npm run pr-risk:review [-- --no-comment] [--judgment pr-risk-judgment.json] [--output high-risk-review.json]

github は pull_request の判定を記録するだけ。マージは変えない。
replay は過去 PR を同じルールで判定し、JSONL と見逃し集計を出す。
review は high（hard_rule または jev_high）のときだけ追加レビューを 1 回呼ぶ。マージは変えない。

環境変数:
  OPENROUTER_API_KEY   Jev と追加レビュー（OpenRouter）。未設定なら API は呼ばない
  HIGH_RISK_REVIEW     off なら追加レビューを呼ばない
  GITHUB_TOKEN         PR コメント（github / review）または過去 PR 取得（replay）
  GITHUB_EVENT_PATH    pull_request イベント JSON
  GITHUB_REPOSITORY    owner/repo`

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

type ReviewCommand = {
  readonly command: 'review'
  readonly noComment: boolean
  readonly judgmentPath: string
  readonly output: string
}

type ParsedArgs = GithubCommand | ReplayCommand | ReviewCommand | { readonly error: string }

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

function parseReviewArgs(rest: readonly string[]): ReviewCommand | { readonly error: string } {
  let noComment = false
  let judgmentPath = PR_RISK_JUDGMENT_FILENAME
  let output = HIGH_RISK_REVIEW_FILENAME
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--no-comment') {
      noComment = true
      continue
    }
    if (arg === '--judgment') {
      const value = rest[index + 1]
      if (value === undefined) {
        return { error: '--judgment の値がありません' }
      }
      judgmentPath = value
      index += 1
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
  return { command: 'review', noComment, judgmentPath, output }
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
  if (command === 'review') {
    return parseReviewArgs(rest)
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

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value)
}

async function readReviewJudgment(io: PrRiskCliIo, path: string): Promise<ReturnType<typeof reviewJudgmentFromJson>> {
  try {
    return reviewJudgmentFromJson(JSON.parse(await io.readFile(path)) as unknown)
  } catch {
    return null
  }
}

async function reviewDiff(
  io: PrRiskCliIo,
  baseSha: string,
  headSha: string,
): Promise<{ readonly paths: readonly string[]; readonly diff: string | null }> {
  if (!isGitSha(baseSha) || !isGitSha(headSha)) {
    return { paths: [], diff: null }
  }
  try {
    const changed = await collectGitChangedFiles(baseSha, headSha, io.execGit)
    return { paths: changed.files.map((file) => file.path), diff: changed.diff }
  } catch {
    return { paths: [], diff: null }
  }
}

async function commentHighRiskReview(io: PrRiskCliIo, record: HighRiskReviewRecord, issue: number | null): Promise<void> {
  if (issue === null) {
    return
  }
  const token = io.env.GITHUB_TOKEN?.trim() ?? ''
  const repository = parseRepository(io.env.GITHUB_REPOSITORY)
  if (token.length === 0 || repository === null) {
    io.stderr.write('GITHUB_TOKEN または GITHUB_REPOSITORY がないのでコメントは省略します\n')
    return
  }
  try {
    const action = await upsertMatchingComment(
      createGitHubIssueCommentApi(token, io.fetch),
      repository.owner,
      repository.repo,
      issue,
      formatHighRiskReviewComment(record),
      (comment) => comment.authorLogin === HIGH_RISK_REVIEW_BOT_LOGIN && isHighRiskReviewComment(comment.body),
    )
    io.stdout.write(`review comment ${action}\n`)
  } catch (cause) {
    io.stderr.write(`コメントの更新に失敗しました: ${cause instanceof Error ? cause.message : String(cause)}\n`)
  }
}

async function runReview(io: PrRiskCliIo, args: ReviewCommand): Promise<number> {
  let eventHeadSha: string | null = null
  let issue: number | null = null
  const eventPath = io.env.GITHUB_EVENT_PATH
  if (eventPath !== undefined && eventPath.trim().length > 0) {
    try {
      const payload = JSON.parse(await io.readFile(eventPath)) as unknown
      const pullRequest = pullRequestFromEvent(payload)
      if (!('error' in pullRequest)) {
        eventHeadSha = pullRequest.headSha
        issue = pullRequest.number
      }
    } catch {
      eventHeadSha = null
    }
  }
  const judgment = await readReviewJudgment(io, args.judgmentPath)
  const baseSha = judgment?.baseSha ?? ''
  const changed =
    judgment === null ? { paths: [], diff: null } : await reviewDiff(io, baseSha, eventHeadSha ?? judgment.headSha)
  const paths = changed.paths.length > 0 ? changed.paths : (judgment?.files ?? [])
  const priorComments = await listReviewComments(io, issue, args.noComment)
  const record = await executeHighRiskReview({
    judgment,
    eventHeadSha,
    paths,
    diff: changed.diff,
    reviewSwitch: io.env[HIGH_RISK_REVIEW_VARIABLE] ?? null,
    apiKey: openRouterApiKey({ OPENROUTER_API_KEY: io.env.OPENROUTER_API_KEY ?? '' }),
    recordedAt: io.now().toISOString(),
    budget: DEFAULT_REVIEW_BUDGET,
    fetchImpl: io.fetch,
    priorComments,
  })
  await io.writeFile(args.output, highRiskReviewJson(record))
  io.stdout.write(
    `${record.status} sha=${record.headSha} called=${record.called} cost=${record.estimatedCostUsd ?? 'none'}\n`,
  )
  if (!args.noComment && record.status !== 'already_called') {
    if (keepsEarlierReviewCall(record.status, record.headSha, priorComments)) {
      io.stdout.write('review comment kept\n')
    } else {
      await commentHighRiskReview(io, record, issue)
    }
  }
  return 0
}

async function listReviewComments(
  io: PrRiskCliIo,
  issue: number | null,
  noComment: boolean,
): Promise<readonly ReviewCallComment[]> {
  if (noComment || issue === null) {
    return []
  }
  const token = io.env.GITHUB_TOKEN?.trim() ?? ''
  const repository = parseRepository(io.env.GITHUB_REPOSITORY)
  if (token.length === 0 || repository === null) {
    return []
  }
  try {
    const comments = await createGitHubIssueCommentApi(token, io.fetch).list(repository.owner, repository.repo, issue)
    return comments.map((comment) => ({ body: comment.body, authorLogin: comment.authorLogin }))
  } catch (cause) {
    io.stderr.write(
      `既存のレビューコメントを読めなかったので、呼び出し済みかは見ていません。${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
    return []
  }
}

export async function runPrRiskCli(io: PrRiskCliIo): Promise<number> {
  const args = parsePrRiskArgs(io.argv)
  if ('error' in args) {
    return writeError(io, args.error)
  }
  try {
    if (args.command === 'github') {
      return await runGithub(io, args)
    }
    if (args.command === 'replay') {
      return await runReplay(io, args)
    }
    return await runReview(io, args)
  } catch (cause) {
    if (args.command === 'review') {
      io.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
      return 0
    }
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
