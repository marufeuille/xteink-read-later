import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { publishCoverageSummary } from '../src/coverage/cli.ts'
import {
  diffCoverage,
  formatMetric,
  isWorkerSource,
  istanbulPercent,
  parseCoverageFinal,
  parseCoverageTotals,
  parseUnifiedDiff,
  renderDiffCoverageReport,
  toRepoPath,
  type FileCoverageData,
  type SourceRange,
} from '../src/coverage/diff-report.ts'
import { changedSourceLines, isFullSha, readEventBefore, resolveDiffBase } from '../src/coverage/git-diff.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repos: string[] = []

function range(line: number, endLine = line): SourceRange {
  return { start: { line, column: 0 }, end: { line: endLine, column: 10 } }
}

function coverageFile(path: string, partial: Partial<FileCoverageData> & Pick<FileCoverageData, 'statementMap' | 's'>): FileCoverageData {
  return {
    path,
    branchMap: {},
    b: {},
    ...partial,
  }
}

function changed(entries: ReadonlyArray<readonly [string, readonly number[]]>): Map<string, Set<number>> {
  return new Map(entries.map(([file, lines]) => [file, new Set(lines)]))
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})

describe('diff coverage report', () => {
  it('keeps worker TypeScript and drops declarations, tests, and docs', () => {
    expect(isWorkerSource('src/http/auth.ts')).toBe(true)
    expect(isWorkerSource('src/env.d.ts')).toBe(false)
    expect(isWorkerSource('test/auth.test.ts')).toBe(false)
    expect(isWorkerSource('docs/coverage.md')).toBe(false)
    expect(toRepoPath('file:///repo/src/http/auth.ts', '/repo')).toBe('src/http/auth.ts')
    expect(toRepoPath('/repo/src/http/auth.ts', '/repo')).toBe('src/http/auth.ts')
  })

  it('uses Istanbul floor percentages', () => {
    expect(istanbulPercent(2, 3)).toBe(66.66)
    expect(istanbulPercent(1, 2)).toBe(50)
    expect(istanbulPercent(0, 0)).toBeNull()
    expect(formatMetric({ covered: 2, total: 3, pct: 66.66 })).toBe('2/3 (66.66%)')
    expect(formatMetric({ covered: 0, total: 0, pct: null })).toBe('0/0')
  })

  it('parses added and modified lines and ignores deletions and non-source files', () => {
    const diff = [
      'diff --git a/src/http/auth.ts b/src/http/auth.ts',
      '--- a/src/http/auth.ts',
      '+++ b/src/http/auth.ts',
      '@@ -3,0 +4,2 @@',
      '+export const added = 1',
      '+export const also = 2',
      '@@ -10 +12 @@',
      '-export const old = 1',
      '+export const changed = 2',
      'diff --git a/src/env.d.ts b/src/env.d.ts',
      '--- a/src/env.d.ts',
      '+++ b/src/env.d.ts',
      '@@ -1 +1 @@',
      '-export {}',
      '+export type T = number',
      'diff --git a/docs/coverage.md b/docs/coverage.md',
      '--- a/docs/coverage.md',
      '+++ b/docs/coverage.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/old.ts b/src/new name.ts',
      '--- a/src/old.ts',
      '+++ "b/src/new name.ts"',
      '@@ -0,0 +1 @@',
      '+export const renamed = 1',
      'diff --git a/src/gone.ts b/src/gone.ts',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const gone = 1',
      'diff --git a/src/bin.ts b/src/bin.ts',
      'Binary files a/src/bin.ts and b/src/bin.ts differ',
      '',
    ].join('\n')

    const lines = parseUnifiedDiff(diff)
    expect([...(lines.get('src/http/auth.ts') ?? [])].sort((a, b) => a - b)).toEqual([4, 5, 12])
    expect(lines.has('src/env.d.ts')).toBe(false)
    expect(lines.has('docs/coverage.md')).toBe(false)
    expect([...(lines.get('src/new name.ts') ?? [])]).toEqual([1])
    expect(lines.has('src/gone.ts')).toBe(false)
    expect(lines.has('src/bin.ts')).toBe(false)
  })

  it('lists uncovered changed lines and branches with file and line', () => {
    const file = coverageFile('/repo/src/a.ts', {
      statementMap: {
        '0': range(1),
        '1': range(4),
        '2': range(8),
      },
      s: { '0': 3, '1': 0, '2': 0 },
      branchMap: {
        '0': {
          type: 'if',
          line: 4,
          loc: range(4, 6),
          locations: [range(4), range(6)],
        },
        '1': {
          type: 'binary-expr',
          line: 20,
          loc: range(20),
          locations: [range(20), range(20)],
        },
      },
      b: {
        '0': [1, 0],
        '1': [1, 1],
      },
    })
    const report = diffCoverage({
      changedLines: changed([
        ['src/a.ts', [1, 2, 4, 6]],
        ['src/missing.ts', [9]],
      ]),
      coverage: { '/repo/src/a.ts': file },
      root: '/repo',
    })

    expect(report.line).toEqual({ covered: 1, total: 2, pct: 50 })
    expect(report.branch).toEqual({ covered: 1, total: 2, pct: 50 })
    expect(report.uncoveredLines).toEqual([{ file: 'src/a.ts', start: 4, end: 4 }])
    expect(report.uncoveredBranches).toEqual([
      { file: 'src/a.ts', line: 6, decisionLine: 4, index: 2, pathCount: 2, type: 'if' },
    ])
    expect(report.missingFiles).toEqual([{ file: 'src/missing.ts', start: 9, end: 9 }])

    const summary = renderDiffCoverageReport({
      diff: report,
      totals: {
        lines: { covered: 10, total: 40, pct: 25 },
        branches: { covered: 1, total: 4, pct: 25 },
      },
      elapsedSeconds: 12,
      vitestStatus: 0,
      diffMode: 'three-dot',
      notes: [],
      maxListed: 1,
    })
    expect(summary).toContain('- `src/a.ts:4`')
    expect(summary).toContain('- `src/a.ts:6`（条件 `src/a.ts:4`） 分岐 2/2（if）')
    expect(summary).toContain('- `src/missing.ts:9`')
    expect(summary).toContain('| 変更箇所 | 1/2 (50%) | 1/2 (50%) |')
    expect(summary).toContain('| 全体 | 10/40 (25%) | 1/4 (25%) |')
    expect(summary).toContain('coverage_elapsed_seconds=12')
    expect(summary).toContain('vitest_exit_status=0')
    expect(summary).not.toContain('src/a.ts:1')
    expect(summary).not.toContain('binary-expr')
  })

  it('reports an uncovered branch when only the condition line changed', () => {
    const file = coverageFile('/repo/src/a.ts', {
      statementMap: { '0': range(4) },
      s: { '0': 1 },
      branchMap: {
        '0': {
          type: 'cond-expr',
          line: 4,
          loc: range(4),
          locations: [range(4), range(9)],
        },
      },
      b: { '0': [1, 0] },
    })
    const report = diffCoverage({
      changedLines: changed([['src/a.ts', [4]]]),
      coverage: { [file.path]: file },
      root: '/repo',
    })
    expect(report.uncoveredLines).toEqual([])
    expect(report.uncoveredBranches).toEqual([
      { file: 'src/a.ts', line: 9, decisionLine: 4, index: 2, pathCount: 2, type: 'cond-expr' },
    ])
    expect(report.branch).toEqual({ covered: 1, total: 2, pct: 50 })
  })

  it('says when the diff has no uncovered worker lines', () => {
    const summary = renderDiffCoverageReport({
      diff: {
        line: { covered: 0, total: 0, pct: null },
        branch: { covered: 0, total: 0, pct: null },
        uncoveredLines: [],
        uncoveredBranches: [],
        missingFiles: [],
      },
      totals: null,
      elapsedSeconds: null,
      vitestStatus: 1,
      diffMode: 'none',
      notes: ['比較元の commit がありません'],
    })
    expect(summary).toContain('未検証の行はありません。')
    expect(summary).toContain('未検証の分岐はありません。')
    expect(summary).toContain('比較なし')
    expect(summary).toContain('計測なし')
    expect(summary).toContain('- 比較元の commit がありません')
    expect(summary).toContain('vitest_exit_status=1')
  })

  it('truncates long uncovered lists and keeps the remainder count', () => {
    const summary = renderDiffCoverageReport({
      diff: {
        line: { covered: 0, total: 2, pct: 0 },
        branch: { covered: 0, total: 0, pct: null },
        uncoveredLines: [
          { file: 'src/a.ts', start: 1, end: 1 },
          { file: 'src/a.ts', start: 3, end: 4 },
        ],
        uncoveredBranches: [],
        missingFiles: [],
      },
      totals: null,
      elapsedSeconds: null,
      vitestStatus: null,
      diffMode: 'two-dot',
      notes: [],
      maxListed: 1,
    })
    expect(summary).toContain('- `src/a.ts:1`')
    expect(summary).toContain('- ほか 1 件')
    expect(summary).not.toContain('src/a.ts:3-4')
  })

  it('reads Istanbul coverage JSON', () => {
    const final = parseCoverageFinal({
      '/repo/src/a.ts': {
        path: '/repo/src/a.ts',
        statementMap: { '0': range(2) },
        s: { '0': 0 },
        branchMap: {},
        b: {},
      },
      '/repo/not-an-object': 'skip',
    })
    expect(final['/repo/src/a.ts']?.s['0']).toBe(0)
    const v8 = parseCoverageFinal({
      '/repo/src/a.ts': {
        path: '/repo/src/a.ts',
        statementMap: { '0': { start: { line: 7, column: 2 }, end: { line: 9, column: null } } },
        s: { '0': 0 },
        branchMap: {
          '0': {
            type: 'if',
            line: 7,
            loc: { start: { line: 7, column: 2 }, end: { line: 9, column: null } },
            locations: [
              { start: { line: 7, column: 2 }, end: { line: 9, column: null } },
              { start: {}, end: {} },
            ],
          },
        },
        b: { '0': [1, 0] },
      },
    })
    const parsed = v8['/repo/src/a.ts']
    expect(parsed?.statementMap['0']?.start.line).toBe(7)
    expect(parsed?.branchMap['0']?.locations[1]).toBeNull()
    const fromV8 = diffCoverage({
      changedLines: changed([['src/a.ts', [7]]]),
      coverage: v8,
      root: '/repo',
    })
    expect(fromV8.uncoveredLines).toEqual([{ file: 'src/a.ts', start: 7, end: 7 }])
    expect(fromV8.uncoveredBranches).toEqual([
      { file: 'src/a.ts', line: 7, decisionLine: 7, index: 2, pathCount: 2, type: 'if' },
    ])
    expect(parseCoverageTotals({
      total: {
        lines: { total: 8, covered: 2, skipped: 0, pct: 25 },
        branches: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' },
      },
    })).toEqual({
      lines: { total: 8, covered: 2, pct: 25 },
      branches: { total: 0, covered: 0, pct: null },
    })
    expect(() => parseCoverageFinal([])).toThrow(/オブジェクトではありません/)
  })
})

describe('diff base', () => {
  it('uses the pull request base and a push parent, and rejects a bad sha', () => {
    expect(isFullSha('a'.repeat(40))).toBe(true)
    expect(isFullSha('0'.repeat(40))).toBe(false)
    expect(resolveDiffBase({ eventName: 'pull_request', baseSha: 'a'.repeat(40), eventBefore: null })).toEqual({
      base: 'a'.repeat(40),
      mode: 'three-dot',
      note: null,
    })
    expect(resolveDiffBase({ eventName: 'merge_group', baseSha: 'b'.repeat(40), eventBefore: null }).mode).toBe('two-dot')
    expect(resolveDiffBase({ eventName: 'push', baseSha: '', eventBefore: 'c'.repeat(40) })).toEqual({
      base: 'c'.repeat(40),
      mode: 'two-dot',
      note: null,
    })
    expect(resolveDiffBase({ eventName: 'push', baseSha: '', eventBefore: '0'.repeat(40) }).note).toBe('比較元の commit がありません')
    expect(resolveDiffBase({ eventName: 'pull_request', baseSha: '--upload-pack=evil', eventBefore: null }).note).toBe('比較元の sha が不正です')
    expect(resolveDiffBase({ eventName: 'push', baseSha: 'not-a-sha', eventBefore: 'd'.repeat(40) }).note).toBe('比較元の sha が不正です')
  })

  it('reads the push before sha from the event payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-event-'))
    repos.push(dir)
    const eventPath = join(dir, 'event.json')
    writeFileSync(eventPath, JSON.stringify({ before: 'e'.repeat(40) }))
    expect(readEventBefore(eventPath, 'push')).toBe('e'.repeat(40))
    expect(readEventBefore(eventPath, 'pull_request')).toBeNull()
    expect(readEventBefore(join(dir, 'missing.json'), 'push')).toBeNull()
  })

  it('diffs the pull request three-dot, not commits that landed on main', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    commitAll(repo, 'base')
    execGit(repo, ['checkout', '-b', 'feature'])
    writeRepoFile(repo, 'src/a.ts', 'export const a = 2\n')
    const feature = commitAll(repo, 'feature')
    execGit(repo, ['checkout', 'main'])
    writeRepoFile(repo, 'src/b.ts', 'export const b = 1\n')
    const main = commitAll(repo, 'main moves')

    const pull = changedSourceLines({
      cwd: repo,
      eventName: 'pull_request',
      headSha: feature,
      baseSha: main,
      eventBefore: null,
    })
    expect(pull.mode).toBe('three-dot')
    expect(pull.note).toBeNull()
    expect([...pull.lines.keys()]).toEqual(['src/a.ts'])
    expect(pull.lines.get('src/a.ts')?.has(1)).toBe(true)

    const linear = initRepo()
    writeRepoFile(linear, 'src/a.ts', 'export const a = 1\n')
    const parent = commitAll(linear, 'parent')
    writeRepoFile(linear, 'src/b.ts', 'export const b = 1\n')
    const child = commitAll(linear, 'child')
    const push = changedSourceLines({
      cwd: linear,
      eventName: 'push',
      headSha: child,
      baseSha: '',
      eventBefore: parent,
    })
    expect(push.mode).toBe('two-dot')
    expect([...push.lines.keys()]).toEqual(['src/b.ts'])
  })
})

describe('coverage summary command', () => {
  it('writes the summary when coverage files are missing and does not throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-summary-'))
    repos.push(dir)
    const summaryPath = join(dir, 'summary.md')
    const summary = publishCoverageSummary({
      cwd: dir,
      diffFile: null,
      coverageFile: join(dir, 'missing-final.json'),
      summaryFile: join(dir, 'missing-summary.json'),
      summaryOut: summaryPath,
      vitestStatus: 1,
      elapsedSeconds: 4,
      eventName: 'push',
      headSha: '',
      baseSha: '',
      eventPath: undefined,
      allowFetch: false,
    })
    expect(summary).toContain('カバレッジ結果を読めませんでした: ENOENT')
    expect(summary).toContain('全体カバレッジを読めませんでした: ENOENT')
    expect(summary).toContain('比較元の commit がありません')
    expect(readFileSync(summaryPath, 'utf8')).toBe(summary)
    expect(summary).toContain('coverage_elapsed_seconds=4')
  })

  it('writes uncovered lines from a diff file and coverage JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-cli-'))
    repos.push(dir)
    const diffFile = join(dir, 'pr.diff')
    const coverageFile = join(dir, 'coverage-final.json')
    const summaryFile = join(dir, 'coverage-summary.json')
    const summaryPath = join(dir, 'summary.md')
    writeFileSync(diffFile, [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2 +2 @@',
      '-export const a = 1',
      '+export const a = 2',
      '',
    ].join('\n'))
    writeFileSync(coverageFile, JSON.stringify({
      [join(dir, 'src/a.ts')]: coverageFileJson(join(dir, 'src/a.ts')),
    }))
    writeFileSync(summaryFile, JSON.stringify({
      total: {
        lines: { total: 5, covered: 1, skipped: 0, pct: 20 },
        branches: { total: 2, covered: 1, skipped: 0, pct: 50 },
      },
    }))
    const summary = publishCoverageSummary({
      cwd: dir,
      diffFile,
      coverageFile,
      summaryFile,
      summaryOut: summaryPath,
      vitestStatus: 0,
      elapsedSeconds: 9,
      eventName: 'pull_request',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      eventPath: undefined,
      allowFetch: false,
    })
    expect(summary).toContain('- `src/a.ts:2`')
    expect(summary).toContain('| 全体 | 1/5 (20%) | 1/2 (50%) |')
    expect(summary).toContain('coverage_elapsed_seconds=9')
  })
})

describe('CI wiring', () => {
  it('runs diff coverage only as a display step on the check path filter', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    const check = jobBody(workflow, 'check')
    const coverage = jobBody(workflow, 'diff-coverage')
    const mergeGate = jobBody(workflow, 'merge-gate')
    expect(check).toContain("if: ${{ needs.changes.outputs.check == 'true' }}")
    expect(check).toContain('npm run test:unit')
    expect(check).not.toContain('--coverage')
    expect(coverage).toContain('name: diff coverage')
    expect(coverage).toContain('needs: changes')
    expect(coverage).toContain("if: ${{ needs.changes.outputs.check == 'true' }}")
    expect(coverage).toContain('continue-on-error: true')
    expect(coverage).toContain('fetch-depth: 0')
    expect(coverage).toContain('bash .github/scripts/ci-diff-coverage.sh')
    expect(coverage).not.toContain('codecov')
    expect(coverage).not.toContain('secrets.')
    expect(mergeGate).toContain('needs: [changes, check, simulator-images]')
    expect(mergeGate).not.toContain('diff-coverage')
    expect(workflow).toContain('name: typecheck, unit, e2e')
    expect(workflow).toContain('name: simulator images')
    expect(workflow).toContain('name: merge-gate')
    expect(workflow).not.toContain('github.event.before')

    const script = readFileSync(join(root, '.github/scripts/ci-diff-coverage.sh'), 'utf8')
    expect(script).toContain('npm run test:unit:coverage')
    expect(script).toContain('exit 0')
    expect(script).not.toMatch(/^set -e/m)
    expect(spawnSync('bash', ['-n', join(root, '.github/scripts/ci-diff-coverage.sh')]).status).toBe(0)

    const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
    expect(config).toContain("provider: 'v8'")
    expect(config).toContain('reportOnFailure: true')
    expect(config).toContain("include: ['src/**/*.ts']")
    expect(config).not.toContain('thresholds')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:unit']).toBe('vitest run')
    expect(pkg.scripts['test:unit:coverage']).toBe('vitest run --coverage')
    const dev = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    expect(dev.devDependencies['@vitest/coverage-v8']).toBe('5.0.1')
    expect(dev.devDependencies['vitest']).toBe('^5.0.1')
  })
})

function jobBody(workflow: string, name: string): string {
  const body = workflow.split(`\n  ${name}:`)[1] ?? ''
  const next = body.search(/\n {2}[a-z0-9-]+:\n/)
  return next < 0 ? body : body.slice(0, next)
}

function coverageFileJson(path: string): FileCoverageData {
  return coverageFile(path, {
    statementMap: { '0': range(2) },
    s: { '0': 0 },
    branchMap: {
      '0': {
        type: 'if',
        line: 2,
        loc: range(2),
        locations: [range(2), range(2)],
      },
    },
    b: { '0': [0, 1] },
  })
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'coverage-git-'))
  repos.push(repo)
  execGit(repo, ['init', '-b', 'main'])
  execGit(repo, ['config', 'user.email', 'test@example.com'])
  execGit(repo, ['config', 'user.name', 'Test'])
  execGit(repo, ['config', 'commit.gpgsign', 'false'])
  return repo
}

function execGit(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

function writeRepoFile(repo: string, path: string, body: string) {
  const full = join(repo, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

function commitAll(repo: string, message: string): string {
  execGit(repo, ['add', '-A'])
  execGit(repo, ['commit', '-m', message])
  return execGit(repo, ['rev-parse', 'HEAD'])
}
