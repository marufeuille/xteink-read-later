import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const changedPathsScript = join(root, '.github/scripts/ci-changed-paths.sh')
const mergeGateScript = join(root, '.github/scripts/ci-merge-gate.sh')

type Flags = { check: boolean; simulator: boolean; deploy: boolean }

const run = (check: boolean, simulator: boolean, deploy: boolean): Flags => ({
  check,
  simulator,
  deploy,
})
const docsOnly = run(false, false, false)
const checkOnly = run(true, false, false)
const checkAndSimulator = run(true, true, false)
const allJobs = run(true, true, true)
const checkAndDeploy = run(true, false, true)

const cases: Array<[string, string[], Flags]> = [
  ['docs only', ['docs/workers-logs.md'], docsOnly],
  ['markdown outside code trees', ['README.md', 'AGENTS.md', 'infra/access/README.md'], docsOnly],
  ['docs image', ['docs/images/band.png'], docsOnly],
  ['docs plus assertion test', ['docs/workers-logs.md', 'test/log.test.ts'], checkOnly],
  ['nested e2e test', ['test/e2e/clip.live.test.ts'], checkOnly],
  ['src', ['src/http/auth.ts'], allJobs],
  ['src markdown', ['src/notes.md'], allJobs],
  ['simulator source', ['simulator/image-band.ts'], checkAndSimulator],
  ['simulator markdown', ['simulator/README.md'], checkAndSimulator],
  ['wrangler', ['wrangler.jsonc'], checkAndDeploy],
  ['migration', ['migrations/0008_example.sql'], checkAndDeploy],
  ['package manifest', ['package.json'], allJobs],
  ['lockfile', ['package-lock.json'], allJobs],
  ['ci workflow', ['.github/workflows/ci.yml'], checkAndSimulator],
  ['pr-risk workflow', ['.github/workflows/pr-risk.yml'], checkOnly],
  ['ensure script', ['.github/scripts/ensure-r2-bucket.sh'], checkAndDeploy],
  ['classifier script', ['.github/scripts/ci-changed-paths.sh'], checkOnly],
  ['merge gate script', ['.github/scripts/ci-merge-gate.sh'], checkOnly],
  ['apply gates script', ['.github/scripts/apply-merge-gates.sh'], checkOnly],
  ['ruleset', ['.github/merge-gates/main-ruleset.json'], checkOnly],
  ['infra terraform', ['infra/access/main.tf'], checkOnly],
  ['unit vitest config', ['vitest.config.ts'], checkOnly],
  ['e2e vitest config', ['vitest.e2e.config.ts'], checkOnly],
  ['simulator vitest config', ['vitest.simulator.config.ts'], checkAndSimulator],
  ['tsconfig', ['tsconfig.json'], allJobs],
  ['dev vars example', ['.dev.vars.example'], checkOnly],
  ['generated worker types', ['worker-configuration.d.ts'], allJobs],
  ['unknown path', ['tools/new-tool.py'], allJobs],
  ['empty diff', [], docsOnly],
  ['docs and src', ['docs/a.md', 'src/index.ts'], allJobs],
]

const repos: string[] = []

function flags(text: string): Flags {
  const values = new Map<string, boolean>()
  for (const line of text.trim().split('\n')) {
    const index = line.indexOf('=')
    if (index === -1) continue
    values.set(line.slice(0, index), line.slice(index + 1) === 'true')
  }
  return {
    check: values.get('check') === true,
    simulator: values.get('simulator') === true,
    deploy: values.get('deploy') === true,
  }
}

const leakedEnv = [
  'EVENT_NAME',
  'HEAD_SHA',
  'BASE_SHA',
  'BEFORE_SHA',
  'GITHUB_EVENT_NAME',
  'GITHUB_SHA',
  'GITHUB_EVENT_PATH',
  'GITHUB_OUTPUT',
  'GITHUB_STEP_SUMMARY',
  'CHANGES_RESULT',
  'CHECK_RESULT',
  'SIMULATOR_RESULT',
] as const

function commandEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of leakedEnv) delete env[key]
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function classify(paths: string[]): Flags {
  const result = spawnSync('bash', [changedPathsScript, 'classify'], {
    input: paths.length === 0 ? '' : `${paths.join('\n')}\n`,
    encoding: 'utf8',
    env: commandEnv(),
  })
  expect(result.status, result.stderr).toBe(0)
  return flags(result.stdout)
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'ci-paths-'))
  repos.push(repo)
  const git = (...args: string[]) => execGit(repo, args)
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  return repo
}

function execGit(repo: string, args: string[]): string {
  return spawnOk('git', args, repo).trim()
}

function spawnOk(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: commandEnv({ LANG: 'C' }),
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
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

function runGithub(repo: string, env: Record<string, string | undefined>) {
  const output = join(repo, 'github-output.txt')
  const result = spawnSync('bash', [changedPathsScript, 'github'], {
    cwd: repo,
    encoding: 'utf8',
    env: commandEnv({ ...env, LANG: 'C', GITHUB_OUTPUT: output }),
    timeout: 15000,
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
  }
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true })
  }
})

describe('CI path filter', () => {
  it.each(cases)('%s', (_name, paths, expected) => {
    expect(classify(paths)).toEqual(expected)
  })

  it('uses the pull request three-dot diff when main has moved ahead', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    commitAll(repo, 'base')
    execGit(repo, ['checkout', '-b', 'feature'])
    writeRepoFile(repo, 'docs/only.md', 'docs\n')
    const feature = commitAll(repo, 'docs')
    execGit(repo, ['checkout', 'main'])
    writeRepoFile(repo, 'src/b.ts', 'export const b = 1\n')
    const main = commitAll(repo, 'src on main')
    const eventPath = join(repo, 'event.json')
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: main } } }))

    const runResult = runGithub(repo, {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: feature,
      GITHUB_EVENT_PATH: eventPath,
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    expect(flags(runResult.stdout)).toEqual(docsOnly)
    expect(flags(runResult.output)).toEqual(docsOnly)
    expect(runResult.stderr).toContain('docs/only.md')
  })

  it('classifies a merge queue diff as the commits being merged', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    commitAll(repo, 'base')
    execGit(repo, ['checkout', '-b', 'feature'])
    writeRepoFile(repo, 'docs/my notes.md', 'docs\n')
    commitAll(repo, 'docs')
    execGit(repo, ['checkout', 'main'])
    writeRepoFile(repo, 'src/b.ts', 'export const b = 1\n')
    const main = commitAll(repo, 'src on main')
    execGit(repo, ['merge', '--no-ff', 'feature', '-m', 'merge feature'])
    const merged = execGit(repo, ['rev-parse', 'HEAD'])
    const eventPath = join(repo, 'event.json')
    writeFileSync(eventPath, JSON.stringify({ merge_group: { base_sha: main } }))

    const runResult = runGithub(repo, {
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_SHA: merged,
      GITHUB_EVENT_PATH: eventPath,
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    expect(flags(runResult.stdout)).toEqual(docsOnly)
    expect(runResult.stderr).toContain('docs/my notes.md')
  })

  it('classifies a normal main push from its previous commit', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    const before = commitAll(repo, 'base')
    writeRepoFile(repo, 'docs/only.md', 'docs\n')
    const head = commitAll(repo, 'docs')
    const eventPath = join(repo, 'event.json')
    writeFileSync(eventPath, JSON.stringify({ before, after: head }))

    const runResult = runGithub(repo, {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: head,
      GITHUB_EVENT_PATH: eventPath,
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    expect(flags(runResult.stdout)).toEqual(docsOnly)
  })

  it('classifies every tracked file when a push has no previous commit', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    const head = commitAll(repo, 'base')
    const eventPath = join(repo, 'event.json')
    writeFileSync(eventPath, JSON.stringify({ before: '0'.repeat(40), after: head }))

    const runResult = runGithub(repo, {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: head,
      GITHUB_EVENT_PATH: eventPath,
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    expect(flags(runResult.stdout)).toEqual(allJobs)
  })

  it('includes both sides of a rename out of src', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    const before = commitAll(repo, 'add source')
    mkdirSync(join(repo, 'docs'))
    execGit(repo, ['mv', 'src/a.ts', 'docs/a.md'])
    const head = commitAll(repo, 'rename to docs')

    const runResult = runGithub(repo, {
      EVENT_NAME: 'push',
      HEAD_SHA: head,
      BEFORE_SHA: before,
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    expect(flags(runResult.stdout)).toEqual(allJobs)
    expect(runResult.stderr).toContain('src/a.ts')
    expect(runResult.stderr).toContain('docs/a.md')
  })

  it('treats deletion of worker source as a deploy change', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'src/my file.ts', 'export const a = 1\n')
    const before = commitAll(repo, 'add source')
    execGit(repo, ['rm', 'src/my file.ts'])
    const head = commitAll(repo, 'remove source')

    const runResult = runGithub(repo, {
      EVENT_NAME: 'push',
      HEAD_SHA: head,
      BEFORE_SHA: before,
    })

    expect(runResult.status, runResult.stderr).toBe(0)
    expect(flags(runResult.stdout)).toEqual(allJobs)
    expect(runResult.stderr).toContain('src/my file.ts')
  })

  it('fails closed when the base commit is missing', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'README.md', 'docs\n')
    const head = commitAll(repo, 'docs')

    const runResult = runGithub(repo, {
      EVENT_NAME: 'pull_request',
      BASE_SHA: 'a'.repeat(40),
      HEAD_SHA: head,
    })

    expect(runResult.status).not.toBe(0)
    expect(runResult.stderr).toContain('not available')
    expect(runResult.stdout).not.toContain('check=')
  })

  it('rejects a revision that is not a full sha', () => {
    const repo = initRepo()
    writeRepoFile(repo, 'README.md', 'docs\n')
    const head = commitAll(repo, 'docs')

    const runResult = runGithub(repo, {
      EVENT_NAME: 'pull_request',
      BASE_SHA: 'HEAD',
      HEAD_SHA: head,
    })

    expect(runResult.status).not.toBe(0)
    expect(runResult.stderr).toContain('refusing non-sha revision')
  })
})

describe('CI merge gate', () => {
  const gate = (changes: string, check: string, simulator: string) =>
    spawnSync('bash', [mergeGateScript, changes, check, simulator], { encoding: 'utf8' })

  it.each([
    ['success', 'success', 'success'],
    ['success', 'skipped', 'skipped'],
    ['success', 'success', 'skipped'],
    ['success', 'skipped', 'success'],
  ])('accepts %s / %s / %s', (changes, check, simulator) => {
    const result = gate(changes, check, simulator)
    expect(result.status, result.stderr).toBe(0)
  })

  it('accepts results from the environment', () => {
    const result = spawnSync('bash', [mergeGateScript], {
      encoding: 'utf8',
      env: commandEnv({
        CHANGES_RESULT: 'success',
        CHECK_RESULT: 'skipped',
        SIMULATOR_RESULT: 'skipped',
      }),
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('check is skipped')
    expect(result.stdout).toContain('simulator-images is skipped')
  })

  it.each([
    ['success', 'failure', 'success'],
    ['success', 'success', 'failure'],
    ['success', 'cancelled', 'skipped'],
    ['success', 'success', 'cancelled'],
    ['failure', 'skipped', 'skipped'],
    ['skipped', 'success', 'success'],
    ['success', '', 'success'],
    ['success', 'success', ''],
    ['success', 'success ', 'skipped'],
  ])('rejects %s / %s / %s', (changes, check, simulator) => {
    expect(gate(changes, check, simulator).status).not.toBe(0)
  })
})
