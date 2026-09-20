import type { PrChangedFile, PrChangedFileStatus, PrRiskJudgment } from '../types'
import { formatPrRiskComment, isPrRiskComment } from './comment'

export type GitHubComment = {
  readonly id: number
  readonly body: string
}

export type GitHubIssueCommentApi = {
  readonly list: (owner: string, repo: string, issue: number) => Promise<readonly GitHubComment[]>
  readonly create: (owner: string, repo: string, issue: number, body: string) => Promise<void>
  readonly update: (owner: string, repo: string, commentId: number, body: string) => Promise<void>
}

export type GitHubPull = {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly headSha: string
  readonly baseSha: string
  readonly headRef: string
  readonly merged: boolean
}

const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'xteink-read-later-pr-risk'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function repoUrl(owner: string, repo: string, path: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/${path}`
}

function githubHeaders(
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT,
    ...extra,
  }
}

async function githubFetch(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: {
    readonly method: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  },
): Promise<Response> {
  const response = await fetchImpl(url, {
    method: init.method,
    headers: githubHeaders(token, init.headers ?? {}),
    ...(init.body === undefined ? {} : { body: init.body }),
  })
  if (!response.ok) {
    throw new Error(`GitHub HTTP ${response.status} ${url}`)
  }
  return response
}

async function githubJson(fetchImpl: typeof fetch, token: string, url: string): Promise<unknown> {
  return (await githubFetch(fetchImpl, token, url, { method: 'GET' })).json()
}

async function githubText(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  accept: string,
): Promise<string> {
  return (await githubFetch(fetchImpl, token, url, { method: 'GET', headers: { Accept: accept } })).text()
}

function commentBody(method: 'POST' | 'PATCH', body: string) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  }
}

export function parseRepository(
  value: string | undefined,
): { readonly owner: string; readonly repo: string } | null {
  if (value === undefined) {
    return null
  }
  const [owner, repo] = value.split('/')
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    return null
  }
  return { owner, repo }
}

function parseGitHubPull(value: unknown): GitHubPull | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: 'pull_request が不正です' }
  }
  const number = asNumber(value.number)
  const title = asString(value.title)
  if (number === null || title === null) {
    return { error: 'pull_request.number / title が不正です' }
  }
  if (!isRecord(value.head) || !isRecord(value.base)) {
    return { error: 'pull_request head/base が不正です' }
  }
  const headSha = asString(value.head.sha)
  const baseSha = asString(value.base.sha)
  if (headSha === null || baseSha === null) {
    return { error: 'head/base SHA が不正です' }
  }
  return {
    number,
    title,
    body: asString(value.body) ?? '',
    headSha,
    baseSha,
    headRef: asString(value.head.ref) ?? '',
    merged: typeof value.merged_at === 'string',
  }
}

function records(payload: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(payload)) {
    return []
  }
  return payload.flatMap((entry) => (isRecord(entry) ? [entry] : []))
}

export function pullRequestFromEvent(payload: unknown): GitHubPull | { readonly error: string } {
  if (!isRecord(payload) || !('pull_request' in payload)) {
    return { error: 'GitHub event に pull_request がありません' }
  }
  return parseGitHubPull(payload.pull_request)
}

function pullsFromGitHubList(payload: unknown): readonly GitHubPull[] {
  return records(payload).flatMap((entry) => {
    const parsed = parseGitHubPull(entry)
    return 'error' in parsed ? [] : [parsed]
  })
}

function changedFileStatus(value: unknown): PrChangedFileStatus {
  switch (value) {
    case 'added':
    case 'modified':
    case 'deleted':
    case 'renamed':
    case 'copied':
      return value
    default:
      return 'unknown'
  }
}

function filesFromGitHubFiles(payload: unknown): readonly PrChangedFile[] {
  return records(payload).flatMap((entry) => {
    const path = asString(entry.filename)
    if (path === null) {
      return []
    }
    const previousPath = asString(entry.previous_filename)
    return [
      {
        path,
        status: changedFileStatus(entry.status),
        additions: asNumber(entry.additions),
        deletions: asNumber(entry.deletions),
        ...(previousPath === null || previousPath.length === 0 ? {} : { previousPath }),
      },
    ]
  })
}

function commentsFromGitHub(payload: unknown): readonly GitHubComment[] {
  return records(payload).flatMap((entry) => {
    const id = asNumber(entry.id)
    const body = asString(entry.body)
    return id === null || body === null ? [] : [{ id, body }]
  })
}

export function createGitHubIssueCommentApi(
  token: string,
  fetchImpl: typeof fetch,
): GitHubIssueCommentApi {
  return {
    async list(owner, repo, issue) {
      return commentsFromGitHub(
        await githubJson(fetchImpl, token, repoUrl(owner, repo, `issues/${issue}/comments?per_page=100`)),
      )
    },
    async create(owner, repo, issue, body) {
      await githubFetch(fetchImpl, token, repoUrl(owner, repo, `issues/${issue}/comments`), commentBody('POST', body))
    },
    async update(owner, repo, commentId, body) {
      await githubFetch(fetchImpl, token, repoUrl(owner, repo, `issues/comments/${commentId}`), commentBody('PATCH', body))
    },
  }
}

const GITHUB_FILES_PER_PAGE = 100
const GITHUB_FILES_MAX_PAGES = 10

async function fetchPullFiles(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{ readonly files: readonly PrChangedFile[]; readonly incomplete: boolean }> {
  const files: PrChangedFile[] = []
  for (let page = 1; page <= GITHUB_FILES_MAX_PAGES; page += 1) {
    const batch = filesFromGitHubFiles(
      await githubJson(
        fetchImpl,
        token,
        repoUrl(owner, repo, `pulls/${number}/files?per_page=${GITHUB_FILES_PER_PAGE}&page=${page}`),
      ),
    )
    files.push(...batch)
    if (batch.length < GITHUB_FILES_PER_PAGE) {
      return { files, incomplete: false }
    }
  }
  return { files, incomplete: true }
}

export async function fetchPullSnapshot(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{
  readonly pull: GitHubPull
  readonly files: readonly PrChangedFile[]
  readonly diff: string
  readonly filesIncomplete: boolean
}> {
  const parsed = parseGitHubPull(await githubJson(fetchImpl, token, repoUrl(owner, repo, `pulls/${number}`)))
  if ('error' in parsed) {
    throw new Error(`PR #${number} を読めません`)
  }
  const listed = await fetchPullFiles(fetchImpl, token, owner, repo, number)
  return {
    pull: parsed,
    files: listed.files,
    diff: await githubText(fetchImpl, token, repoUrl(owner, repo, `pulls/${number}`), 'application/vnd.github.diff'),
    filesIncomplete: listed.incomplete,
  }
}

export async function listMergedPullNumbers(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  limit: number,
): Promise<readonly number[]> {
  return pullsFromGitHubList(
    await githubJson(
      fetchImpl,
      token,
      repoUrl(owner, repo, `pulls?state=closed&per_page=${limit}&sort=updated&direction=desc`),
    ),
  )
    .filter((pull) => pull.merged)
    .map((pull) => pull.number)
    .slice(0, limit)
}

export async function upsertPrRiskComment(
  api: GitHubIssueCommentApi,
  owner: string,
  repo: string,
  issue: number,
  judgment: PrRiskJudgment,
): Promise<'created' | 'updated'> {
  const body = formatPrRiskComment(judgment)
  const existing = (await api.list(owner, repo, issue)).find((comment) => isPrRiskComment(comment.body))
  if (existing === undefined) {
    await api.create(owner, repo, issue, body)
    return 'created'
  }
  await api.update(owner, repo, existing.id, body)
  return 'updated'
}
