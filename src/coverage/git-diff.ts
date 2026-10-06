import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { isWorkerSource, parseUnifiedDiff } from './diff-report.ts'

const FULL_SHA = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/

export type DiffMode = 'three-dot' | 'two-dot' | 'none'

export type ChangedSourceLines = {
  readonly lines: ReadonlyMap<string, ReadonlySet<number>>
  readonly mode: DiffMode
  readonly note: string | null
}

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value) && !/^0+$/.test(value)
}

export function resolveDiffBase(input: {
  readonly eventName: string
  readonly baseSha: string
  readonly eventBefore: string | null
}): { readonly base: string | null; readonly mode: DiffMode; readonly note: string | null } {
  const explicit = input.baseSha.trim()
  if (explicit.length > 0 && !isFullSha(explicit)) {
    return { base: null, mode: 'none', note: '比較元の sha が不正です' }
  }
  const base = isFullSha(explicit)
    ? explicit
    : input.eventName === 'push' && input.eventBefore !== null && isFullSha(input.eventBefore)
      ? input.eventBefore
      : null
  if (base === null) {
    return { base: null, mode: 'none', note: '比較元の commit がありません' }
  }
  return {
    base,
    mode: input.eventName === 'pull_request' ? 'three-dot' : 'two-dot',
    note: null,
  }
}

export function readEventBefore(eventPath: string | undefined, eventName: string): string | null {
  if (eventName !== 'push' || eventPath === undefined || eventPath.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(eventPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const before = Reflect.get(parsed, 'before')
    return typeof before === 'string' ? before : null
  } catch {
    return null
  }
}

export function changedSourceLines(input: {
  readonly cwd: string
  readonly eventName: string
  readonly headSha: string
  readonly baseSha: string
  readonly eventBefore: string | null
  readonly allowFetch?: boolean
}): ChangedSourceLines {
  const resolved = resolveDiffBase(input)
  if (resolved.base === null || resolved.mode === 'none') {
    return { lines: new Map(), mode: 'none', note: resolved.note }
  }
  if (!isFullSha(input.headSha)) {
    return { lines: new Map(), mode: 'none', note: 'head の sha が不正です' }
  }
  const allowFetch = input.allowFetch ?? false
  if (!ensureCommit(input.cwd, resolved.base, allowFetch) || !ensureCommit(input.cwd, input.headSha, allowFetch)) {
    return { lines: new Map(), mode: 'none', note: '比較する commit を取得できませんでした' }
  }
  const args = ['diff', '-U0', '--find-renames']
  if (resolved.mode === 'three-dot') args.push(`${resolved.base}...${input.headSha}`)
  else args.push(resolved.base, input.headSha)
  const diff = git(input.cwd, args)
  if (diff.status !== 0) {
    return { lines: new Map(), mode: resolved.mode, note: 'git diff に失敗しました' }
  }
  const lines = new Map<string, Set<number>>()
  for (const [path, numbers] of parseUnifiedDiff(diff.stdout)) {
    if (isWorkerSource(path)) lines.set(path, numbers)
  }
  return { lines, mode: resolved.mode, note: null }
}

function ensureCommit(cwd: string, sha: string, allowFetch: boolean): boolean {
  if (hasCommit(cwd, sha)) return true
  if (!allowFetch) return false
  git(cwd, ['fetch', '--no-tags', 'origin', sha])
  return hasCommit(cwd, sha)
}

function hasCommit(cwd: string, sha: string): boolean {
  return git(cwd, ['cat-file', '-e', `${sha}^{commit}`]).status === 0
}

function git(cwd: string, args: string[]): { readonly status: number; readonly stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}
