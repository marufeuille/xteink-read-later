import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { SMOKE_PHRASE } from '../src/smoke/constants'
import { postSmokeSlack } from '../src/smoke/run'
import {
  ROLLBACK_REVERT_NOTE,
  bindingsOrTriggersChanged,
  buildRollbackSlackMessage,
  diffHasMigrations,
  fetchLiveWorkerVersion,
  formatGithubOutput,
  readDeployDiff,
  rollbackCommandFailure,
  runDeployRollback,
  safeStderrHead,
  smokeResultOutputs,
  wranglerRollbackInvocation,
  type DeployDiff,
  type RollbackAttempt,
  type RollbackContext,
} from '../src/smoke/rollback'
import { parseWorkerDeploymentIdentity, parseWorkerVersionSourceSha } from '../src/smoke/worker-version'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'smoke-clip-token-value'
const PASS = 'smoke-opds-password-value'
const WEBHOOK = 'https://hooks.slack.example/services/T000/B000/secret-hook'
const ARTICLE = 'https://fixture.example/smoke/article.html'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const PREV = '01234567-89ab-cdef-0123-456789abcdef'
const CUR = '89abcdef-0123-4567-89ab-cdef01234567'
const NEWER = 'fedcba98-7654-3210-fedc-ba9876543210'
const RUN = 'https://github.com/marufeuille/xteink-read-later/actions/runs/123'
const SECRETS = [TOKEN, PASS, WEBHOOK, ARTICLE, SMOKE_PHRASE]

const codeDiff: DeployDiff = {
  paths: ['src/index.ts'],
  wranglerBefore: null,
  wranglerAfter: null,
  diffKnown: true,
}

function context(overrides: Partial<RollbackContext> = {}): RollbackContext {
  return {
    jobResult: 'failure',
    outcome: 'failed',
    failedStep: 'verify-epub',
    errorKind: 'epub_phrase',
    cleanupErrorKind: '-',
    previousWorkerVersion: PREV,
    workerVersion: CUR,
    githubSha: SHA,
    runUrl: RUN,
    runId: '123',
    ...overrides,
  }
}

function assertNoLeak(text: string) {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret)
  }
  expect(text).not.toContain('Bearer')
  expect(text).not.toContain('@')
}

async function decide(input: {
  readonly context?: Partial<RollbackContext>
  readonly diff?: DeployDiff
  readonly live?: string
  readonly rollbackOk?: boolean
  readonly rollbackResult?: boolean | RollbackAttempt
  readonly verify?: () => Promise<'passed' | 'failed' | 'skipped'>
  readonly verifyDeadlineMs?: number
  readonly log?: (line: string) => void
}) {
  const rollback = vi.fn(async () => input.rollbackResult ?? input.rollbackOk ?? true)
  const verify = vi.fn(input.verify ?? (async () => 'passed' as const))
  const notify = vi.fn(async () => {})
  const summarize = vi.fn()
  const result = await runDeployRollback({
    context: context(input.context),
    diff: input.diff ?? codeDiff,
    liveWorkerVersion: input.live ?? CUR,
    rollback,
    verify,
    notify,
    summarize,
    ...(input.verifyDeadlineMs === undefined ? {} : { verifyDeadlineMs: input.verifyDeadlineMs }),
    ...(input.log === undefined ? {} : { log: input.log }),
  })
  return { result, rollback, verify, notify, summarize }
}

describe('deploy rollback', () => {
  it('rolls back an allowlisted failure to the recorded previous version once', async () => {
    const failingVerify = await decide({ verify: async () => 'failed' })
    expect(failingVerify.rollback).toHaveBeenCalledOnce()
    expect(failingVerify.rollback).toHaveBeenCalledWith(PREV, `deploy-rollback sha=${SHA} run=123`)
    expect(failingVerify.verify).toHaveBeenCalledOnce()
    expect(failingVerify.result.result).toBe('rolled_back')
    expect(failingVerify.result.verify).toBe('still_failing')
    expect(failingVerify.result.exitCode).toBe(0)
    expect(failingVerify.result.message).toContain(ROLLBACK_REVERT_NOTE)
    expect(failingVerify.result.message).toContain('trigger=verify-epub/epub_phrase')
    expect(failingVerify.result.message).toContain(`from=${CUR}`)
    expect(failingVerify.result.message).toContain(`to=${PREV}`)
    expect(failingVerify.notify).toHaveBeenCalledWith(failingVerify.result.message)
    expect(failingVerify.summarize).toHaveBeenCalledWith(failingVerify.result.message)

    const verified = await decide({})
    expect(verified.result.verify).toBe('verified')
    expect(verified.result.exitCode).toBe(0)
    expect(verified.rollback).toHaveBeenCalledOnce()
  })

  it('fails the job when rollback itself fails and does not verify or try again', async () => {
    const { result, rollback, verify } = await decide({ rollbackOk: false })
    expect(result.exitCode).toBe(1)
    expect(result.result).toBe('rollback_failed')
    expect(result.verify).toBe('-')
    expect(result.rolledBack).toBe(false)
    expect(result.message).not.toContain(ROLLBACK_REVERT_NOTE)
    expect(rollback).toHaveBeenCalledOnce()
    expect(verify).not.toHaveBeenCalled()
  })

  it('does not roll back notify-only smoke results', async () => {
    const cases: Array<{
      readonly name: string
      readonly context: Partial<RollbackContext>
      readonly reason: string
      readonly notify: boolean
      readonly diff?: DeployDiff
      readonly live?: string
    }> = [
      {
        name: 'unset skip',
        context: { jobResult: 'success', outcome: 'skipped', failedStep: '-', errorKind: '-' },
        reason: 'skip',
        notify: false,
      },
      {
        name: 'passed',
        context: { jobResult: 'success', outcome: 'passed', failedStep: '-', errorKind: '-' },
        reason: 'passed',
        notify: false,
      },
      {
        name: 'cancelled',
        context: { jobResult: 'cancelled', outcome: 'failed', failedStep: 'verify-epub', errorKind: 'epub_phrase' },
        reason: 'cancelled',
        notify: true,
      },
      {
        name: 'network',
        context: { failedStep: 'post-clip', errorKind: 'network' },
        reason: 'external',
        notify: true,
      },
      {
        name: 'fetch_failed',
        context: { failedStep: 'poll-job', errorKind: 'fetch_failed' },
        reason: 'external',
        notify: true,
      },
      {
        name: 'http_401',
        context: { failedStep: 'post-clip', errorKind: 'http_401' },
        reason: 'external',
        notify: true,
      },
      {
        name: 'http_403',
        context: { failedStep: 'opds-catalog', errorKind: 'http_403' },
        reason: 'external',
        notify: true,
      },
      {
        name: 'interrupted',
        context: { failedStep: 'smoke', errorKind: 'interrupted' },
        reason: 'external',
        notify: true,
      },
      {
        name: 'article-preflight',
        context: { failedStep: 'article-preflight', errorKind: 'phrase_missing' },
        reason: 'preflight',
        notify: true,
      },
      {
        name: 'poll-job timeout',
        context: { failedStep: 'poll-job', errorKind: 'timeout' },
        reason: 'timeout',
        notify: true,
      },
      {
        name: 'delete only',
        context: {
          jobResult: 'failure',
          outcome: 'passed',
          failedStep: '-',
          errorKind: '-',
          cleanupErrorKind: 'http_500',
        },
        reason: 'delete',
        notify: true,
      },
      {
        name: 'not on the allowlist',
        context: { failedStep: 'poll-job', errorKind: 'invalid_response' },
        reason: 'not_allowlisted',
        notify: true,
      },
      {
        name: 'migrations deploy',
        context: {},
        diff: { ...codeDiff, paths: ['src/index.ts', 'migrations/0010_example.sql'] },
        reason: 'migration',
        notify: true,
      },
      {
        name: 'version mismatch',
        context: {},
        live: NEWER,
        reason: 'version_mismatch',
        notify: true,
      },
      {
        name: 'unknown version',
        context: { previousWorkerVersion: 'unknown' },
        reason: 'unknown_version',
        notify: true,
      },
      {
        name: 'worker version unknown',
        context: { workerVersion: 'unknown' },
        reason: 'unknown_version',
        notify: true,
      },
      {
        name: 'previous version is this deploy',
        context: { previousWorkerVersion: CUR, workerVersion: CUR },
        reason: 'same_version',
        notify: true,
      },
      {
        name: 'unknown diff',
        context: {},
        diff: { paths: [], wranglerBefore: null, wranglerAfter: null, diffKnown: false },
        reason: 'unknown_diff',
        notify: true,
      },
    ]

    for (const item of cases) {
      const { result, rollback, verify } = await decide({
        context: item.context,
        ...(item.diff === undefined ? {} : { diff: item.diff }),
        ...(item.live === undefined ? {} : { live: item.live }),
      })
      expect(rollback, item.name).not.toHaveBeenCalled()
      expect(verify, item.name).not.toHaveBeenCalled()
      expect(result.exitCode, item.name).toBe(0)
      expect(result.rolledBack, item.name).toBe(false)
      expect(result.result, item.name).toBe(`skipped:${item.reason}`)
      expect(result.notified, item.name).toBe(item.notify)
      if (item.notify) {
        expect(result.message, item.name).toContain(`result=skipped:${item.reason}`)
        if (item.reason === 'delete') {
          expect(result.message, item.name).toContain('trigger=delete/http_500')
        }
        expect(result.message, item.name).not.toContain(ROLLBACK_REVERT_NOTE)
        expect(result.message, item.name).toContain('verify=-')
        assertNoLeak(result.message ?? '')
      } else {
        expect(result.message, item.name).toBeNull()
      }
    }
  })

  it('rolls back only the allowlisted step and errorKind pairs', async () => {
    const allowlisted = [
      ['post-clip', 'http_500'],
      ['post-clip', 'http_599'],
      ['post-clip', 'http_5xx'],
      ['poll-job', 'extract_failed'],
      ['poll-job', 'epub_failed'],
      ['poll-job', 'internal_error'],
      ['opds-catalog', 'not_in_catalog'],
      ['opds-catalog', 'http_502'],
      ['download-epub', 'http_500'],
      ['verify-epub', 'epub_phrase'],
      ['verify-epub', 'epub_not_zip'],
      ['verify-epub', 'epub_mimetype'],
      ['verify-epub', 'epub_container'],
      ['verify-epub', 'epub_opf'],
    ] as const
    for (const [failedStep, errorKind] of allowlisted) {
      const { rollback, result } = await decide({ context: { failedStep, errorKind } })
      expect(rollback, `${failedStep}/${errorKind}`).toHaveBeenCalledOnce()
      expect(result.result, `${failedStep}/${errorKind}`).toBe('rolled_back')
      expect(rollback, `${failedStep}/${errorKind}`).toHaveBeenCalledWith(
        PREV,
        expect.stringContaining('deploy-rollback sha='),
      )
    }
    const refused = [
      ['post-clip', 'http_400'],
      ['post-clip', 'http_499'],
      ['download-epub', 'epub_too_large'],
      ['download-epub', 'http_404'],
      ['verify-epub', 'http_500'],
      ['opds-catalog', 'invalid_response'],
    ] as const
    for (const [failedStep, errorKind] of refused) {
      const { rollback, result } = await decide({ context: { failedStep, errorKind } })
      expect(rollback, `${failedStep}/${errorKind}`).not.toHaveBeenCalled()
      expect(result.result, `${failedStep}/${errorKind}`).toBe('skipped:not_allowlisted')
    }
  })

  it('blocks rollback when the live version sha includes a migration that event.before misses', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rollback-diff-'))
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'dev@localhost',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'dev@localhost',
    }
    const git = (args: readonly string[]) => {
      const run = spawnSync('git', [...args], { cwd: repo, env: gitEnv, encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(0)
      return run.stdout.trim()
    }
    git(['init', '-b', 'main'])
    writeFileSync(join(repo, 'src.txt'), 'a\n')
    git(['add', 'src.txt'])
    git(['commit', '-m', 'A'])
    const live = git(['rev-parse', 'HEAD'])
    mkdirSync(join(repo, 'migrations'))
    writeFileSync(join(repo, 'migrations', '0001_example.sql'), '-- b\n')
    git(['add', 'migrations/0001_example.sql'])
    git(['commit', '-m', 'B'])
    const eventBefore = git(['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'src.txt'), 'c\n')
    git(['add', 'src.txt'])
    git(['commit', '-m', 'C'])
    const head = git(['rev-parse', 'HEAD'])

    const fromLive = readDeployDiff(live, head, repo)
    const fromEventBefore = readDeployDiff(eventBefore, head, repo)
    expect(fromLive.diffKnown).toBe(true)
    expect(diffHasMigrations(fromLive.paths)).toBe(true)
    expect(fromEventBefore.diffKnown).toBe(true)
    expect(diffHasMigrations(fromEventBefore.paths)).toBe(false)

    const blocked = await decide({ diff: fromLive })
    expect(blocked.rollback).not.toHaveBeenCalled()
    expect(blocked.result.result).toBe('skipped:migration')
    expect(blocked.result.notified).toBe(true)

    const missed = await decide({ diff: fromEventBefore })
    expect(missed.rollback).toHaveBeenCalledOnce()
    expect(missed.result.result).toBe('rolled_back')
  })

  it('skips rollback when the live version sha cannot be resolved', async () => {
    const identity = parseWorkerDeploymentIdentity({
      result: {
        latest: {
          author_email: 'person@example.com',
          annotations: { 'workers/message': `https://example.test/${TOKEN}` },
          versions: [{ version_id: PREV, percentage: 100 }],
        },
      },
    })
    expect(identity.versionId).toBe(PREV)
    expect(identity.sourceSha).toBe('unknown')
    expect(JSON.stringify(identity)).not.toContain(TOKEN)
    expect(JSON.stringify(identity)).not.toContain('person@example.com')
    expect(JSON.stringify(identity)).not.toContain('https://')

    const diff = readDeployDiff(identity.sourceSha, SHA)
    expect(diff.diffKnown).toBe(false)
    const { result, rollback } = await decide({ diff })
    expect(rollback).not.toHaveBeenCalled()
    expect(result.result).toBe('skipped:unknown_diff')
    expect(result.notified).toBe(true)
    expect(result.exitCode).toBe(0)
    assertNoLeak(result.message ?? '')
  })

  it('reads the sha stamped on the deployment that produced the live version', () => {
    const liveSha = 'fedcba9876543210fedcba9876543210fedcba98'
    const identity = parseWorkerDeploymentIdentity({
      result: {
        latest: {
          author_email: 'person@example.com',
          annotations: { 'workers/message': `deploy-sha=${liveSha}` },
          versions: [{ version_id: PREV, percentage: 100 }],
        },
      },
    })
    expect(identity).toEqual({ versionId: PREV, sourceSha: liveSha })
    expect(parseWorkerVersionSourceSha({
      result: {
        author_email: 'person@example.com',
        annotations: { 'workers/message': `deploy-sha=${liveSha}` },
      },
    })).toBe(liveSha)
    expect(parseWorkerDeploymentIdentity({
      result: {
        deployments: [
          {
            annotations: { 'workers/commit_sha': liveSha.toUpperCase() },
            versions: [{ version_id: CUR, percentage: 100 }],
          },
        ],
      },
    })).toEqual({ versionId: CUR, sourceSha: liveSha })
    expect(parseWorkerDeploymentIdentity({
      result: {
        latest: {
          versions: [
            {
              version_id: PREV,
              percentage: 100,
              annotations: { 'workers/message': `deploy-sha=${liveSha}` },
            },
          ],
        },
      },
    }).sourceSha).toBe(liveSha)
    expect(parseWorkerVersionSourceSha({
      result: { annotations: { 'workers/message': `note ${TOKEN}` } },
    })).toBe('unknown')
  })

  it('notifies rolled_back with verify - when verify misses the deadline', async () => {
    const { result, rollback, verify, notify } = await decide({
      verify: () => new Promise(() => {}),
      verifyDeadlineMs: 30,
    })
    expect(rollback).toHaveBeenCalledOnce()
    expect(verify).toHaveBeenCalledOnce()
    expect(result.result).toBe('rolled_back')
    expect(result.verify).toBe('-')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('verify=-')
    expect(result.message).toContain(ROLLBACK_REVERT_NOTE)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(result.message)
  })

  it('logs the wrangler exit code and drops stderr that can hold a token', async () => {
    expect(safeStderrHead('✘ [ERROR] Worker version not found\nhttps://example.test/secret')).toBe(
      '[ERROR] Worker version not found',
    )
    expect(safeStderrHead(`Bearer ${TOKEN}`)).toBeNull()
    expect(safeStderrHead('The following secrets have changed: CLIP_TOKEN')).toBeNull()
    expect(rollbackCommandFailure({ status: 1, stderr: '✘ [ERROR] Worker version not found\n' })).toEqual({
      exitCode: 1,
      stderrHead: '[ERROR] Worker version not found',
    })
    expect(rollbackCommandFailure({ status: 1, stderr: `authorization ${TOKEN}` }).stderrHead).toBeNull()

    const logs: string[] = []
    const leaked = await decide({
      rollbackResult: {
        ok: false,
        exitCode: 1,
        stderrHead: `Bearer ${TOKEN}\n[ERROR] Worker version not found`,
      },
      log: (line) => {
        logs.push(line)
      },
    })
    expect(leaked.result.exitCode).toBe(1)
    expect(leaked.result.result).toBe('rollback_failed')
    expect(logs[0]).toBe('rollback_failed exit=1 stderr=-')
    expect(logs[1]).toBe(leaked.result.message)
    expect(leaked.result.message).not.toContain('stderr')
    expect(leaked.result.message).not.toContain(TOKEN)
    expect(leaked.summarize).toHaveBeenCalledWith(leaked.result.message)
    assertNoLeak(logs.join('\n'))

    const safeLogs: string[] = []
    const safe = await decide({
      rollbackResult: { ok: false, exitCode: 2, stderrHead: '[ERROR] Worker version not found' },
      log: (line) => {
        safeLogs.push(line)
      },
    })
    expect(safeLogs[0]).toBe('rollback_failed exit=2 stderr=[ERROR] Worker version not found')
    expect(safe.result.message).not.toContain('stderr')
    expect(safe.result.message).not.toContain('Worker version')
  })

  it('does not let an old run or a manual re-run roll back a newer release', async () => {
    const { result, rollback } = await decide({ live: NEWER })
    expect(rollback).not.toHaveBeenCalled()
    expect(result.result).toBe('skipped:version_mismatch')
    expect(result.message).toContain(`from=${CUR}`)
    expect(result.message).toContain('to=-')
    expect(result.message).not.toContain(NEWER)
  })

  it('treats bindings and trigger edits as unsafe to roll back, and ignores other wrangler edits', () => {
    const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
    const same: DeployDiff = {
      paths: ['wrangler.jsonc'],
      wranglerBefore: wrangler,
      wranglerAfter: wrangler,
      diffKnown: true,
    }
    expect(bindingsOrTriggersChanged(same)).toBe(false)
    expect(
      bindingsOrTriggersChanged({
        ...same,
        wranglerAfter: wrangler.replace('Paid Workers', 'Paid Workers plan'),
      }),
    ).toBe(false)
    expect(
      bindingsOrTriggersChanged({
        ...same,
        wranglerAfter: wrangler.replace('"compatibility_date": "2026-09-19"', '"compatibility_date": "2026-09-20"'),
      }),
    ).toBe(false)
    expect(
      bindingsOrTriggersChanged({
        ...same,
        wranglerAfter: wrangler.replace('"0 19 * * *"', '"15 19 * * *"'),
      }),
    ).toBe(true)
    expect(
      bindingsOrTriggersChanged({
        ...same,
        wranglerAfter: wrangler.replace(
          'https://xteink-read-later.marufeuille.workers.dev',
          'https://example.invalid',
        ),
      }),
    ).toBe(true)
    expect(diffHasMigrations(['migrations/0010_example.sql'])).toBe(true)
    expect(diffHasMigrations(['docs/deploy-smoke.md', 'src/smoke/rollback.ts'])).toBe(false)
    const beforeEnv =
      '{ "compatibility_date": "2026-09-19", "env": { "production": { "triggers": { "crons": ["0 19 * * *"] } } } }\n'
    expect(
      bindingsOrTriggersChanged({
        paths: ['wrangler.jsonc'],
        wranglerBefore: beforeEnv,
        wranglerAfter: beforeEnv.replace('0 19', '15 19'),
        diffKnown: true,
      }),
    ).toBe(true)
    expect(
      bindingsOrTriggersChanged({
        paths: ['wrangler.jsonc'],
        wranglerBefore: beforeEnv,
        wranglerAfter: beforeEnv.replace('2026-09-19', '2026-09-20'),
        diffKnown: true,
      }),
    ).toBe(false)

    const withUrl = '{ "vars": { "PUBLIC_ORIGIN": "https://example.test // not a comment" } }\n'
    expect(
      bindingsOrTriggersChanged({
        paths: ['wrangler.jsonc'],
        wranglerBefore: withUrl,
        wranglerAfter: withUrl,
        diffKnown: true,
      }),
    ).toBe(false)
  })

  it('keeps the rollback slack message on the allowlisted fields', async () => {
    const message = buildRollbackSlackMessage({
      githubSha: SHA,
      fromVersion: CUR,
      toVersion: PREV,
      failedStep: 'post-clip',
      errorKind: 'http_500',
      result: 'rolled_back',
      verify: 'verified',
      runUrl: RUN,
    })
    expect(message).toBe(
      `[deploy-rollback] sha=${SHA} from=${CUR} to=${PREV} trigger=post-clip/http_500 result=rolled_back verify=verified runUrl=${RUN} ${ROLLBACK_REVERT_NOTE}`,
    )
    expect(message.startsWith('[deploy-rollback]')).toBe(true)
    expect(message.match(/https:\/\//g)).toEqual([
      'https://',
    ])
    expect(message).toContain(RUN)

    const leaked = buildRollbackSlackMessage({
      githubSha: ARTICLE,
      fromVersion: TOKEN,
      toVersion: WEBHOOK,
      failedStep: SMOKE_PHRASE,
      errorKind: `http_500 ${ARTICLE}`,
      result: `rolled_back ${TOKEN}`,
      verify: ARTICLE,
      runUrl: ARTICLE,
    })
    expect(leaked.startsWith('[deploy-rollback]')).toBe(true)
    assertNoLeak(leaked)
    expect(leaked).toContain('sha=unknown')
    expect(leaked).toContain('from=unknown')
    expect(leaked).toContain('to=unknown')
    expect(leaked).toContain('trigger=unknown/-')
    expect(leaked).toContain('result=skipped:unknown')
    expect(leaked).toContain('verify=-')
    expect(leaked).toContain('runUrl=-')
    expect(leaked).not.toContain(ROLLBACK_REVERT_NOTE)
    expect(leaked).not.toMatch(/https?:\/\//)

    const posted: string[] = []
    await postSmokeSlack(WEBHOOK, leaked, async (_url, init) => {
      posted.push(String(init?.body))
      return new Response('ok', { status: 200 })
    })
    expect(posted).toHaveLength(1)
    assertNoLeak(posted[0] ?? '')
    await expect(
      postSmokeSlack(WEBHOOK, ARTICLE, async () => new Response('ok', { status: 200 })),
    ).rejects.toThrow('slack message rejected')
  })

  it('requires a version id on the wrangler rollback command', () => {
    const invocation = wranglerRollbackInvocation(PREV, `deploy-rollback sha=${SHA} run=123`)
    expect(invocation.command.endsWith(`${join('node_modules', '.bin', 'wrangler')}`)).toBe(true)
    expect(invocation.args).toEqual(['rollback', PREV, '--message', `deploy-rollback sha=${SHA} run=123`, '--yes'])
    expect(invocation.args[0]).toBe('rollback')
    expect(invocation.args[1]).toBe(PREV)
    expect(() => wranglerRollbackInvocation('', `deploy-rollback sha=${SHA} run=123`)).toThrow(/version id/)
    expect(() => wranglerRollbackInvocation('unknown', `deploy-rollback sha=${SHA} run=123`)).toThrow(/version id/)
    expect(() => wranglerRollbackInvocation(PREV, 'rollback')).toThrow(/message/)
  })

  it('reads a live version id and drops the rest of the deployment body', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        result: {
          latest: {
            author_email: 'person@example.com',
            versions: [{ version_id: CUR, percentage: 100 }],
          },
        },
      }),
    )
    const version = await fetchLiveWorkerVersion({
      accountId: 'account',
      apiToken: TOKEN,
      fetchImpl,
    })
    expect(version).toBe(CUR)
    expect(version).not.toContain('person@example.com')
    expect(version).not.toContain(TOKEN)
    const denied = await fetchLiveWorkerVersion({
      accountId: 'account',
      apiToken: TOKEN,
      fetchImpl: async () => new Response('no', { status: 403 }),
    })
    expect(denied).toBe('unknown')
    const offline = await fetchLiveWorkerVersion({
      accountId: '',
      apiToken: '',
      fetchImpl: async () => {
        throw new Error('network')
      },
    })
    expect(offline).toBe('unknown')
  })

  it('fails closed when the deploy diff cannot be read', () => {
    expect(readDeployDiff('not-a-sha', SHA).diffKnown).toBe(false)
    expect(readDeployDiff('0'.repeat(40), SHA).diffKnown).toBe(false)
  })

  it('exports smoke outcome fields without extra state', () => {
    expect(
      smokeResultOutputs({
        outcome: 'failed',
        failedStep: 'poll-job',
        errorKind: 'timeout',
        cleanupErrorKind: null,
      }),
    ).toEqual({
      outcome: 'failed',
      failedStep: 'poll-job',
      errorKind: 'timeout',
      cleanupErrorKind: '-',
    })
    expect(smokeResultOutputs(null)).toEqual({
      outcome: 'unknown',
      failedStep: '-',
      errorKind: '-',
      cleanupErrorKind: '-',
    })
    expect(formatGithubOutput('failedStep', 'post-clip\nhttps://evil.example')).toBe('failedStep=post-cliphttps://evil.example\n')
    expect(() => formatGithubOutput('bad name', 'x')).toThrow(/output name/)
  })

  it('records the previous version before deploy and wires rollback without new secrets', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    const mergeGate = workflow.split('\n  merge-gate:')[1]?.split('\n  deploy:')[0] ?? ''
    expect(mergeGate).toContain('bash .github/scripts/ci-merge-gate.sh')
    expect(mergeGate).not.toContain('rollback')
    expect(mergeGate).not.toContain('previous_worker_version')

    const deploy = workflow.split('\n  deploy:')[1]?.split('\n  deploy-smoke:')[0] ?? ''
    const before = deploy.indexOf('record-deploy-revision.sh before')
    const deployCommand = deploy.indexOf('command: deploy')
    const after = deploy.indexOf('record-deploy-revision.sh after')
    expect(before).toBeGreaterThan(-1)
    expect(before).toBeLessThan(deployCommand)
    expect(deployCommand).toBeLessThan(after)
    expect(deploy).toContain('previous_worker_version: ${{ steps.previous.outputs.previous_worker_version }}')
    expect(deploy).toContain('previous_worker_sha: ${{ steps.previous.outputs.previous_worker_sha }}')
    expect(deploy).toContain('command: deploy --message deploy-sha=${{ github.sha }}')
    expect(workflow).not.toContain('github.event.before')

    const rollback = workflow.split('\n  deploy-rollback:')[1] ?? ''
    expect(rollback).toContain('needs: [deploy, deploy-smoke]')
    expect(rollback).toContain('if: ${{ always()')
    expect(rollback).toContain("github.event_name == 'push'")
    expect(rollback).toContain("github.ref == 'refs/heads/main'")
    expect(rollback).toContain("needs.deploy-smoke.result == 'failure'")
    expect(rollback).toContain("needs.deploy-smoke.result == 'cancelled'")
    expect(rollback).toContain('src/smoke/cli.ts rollback')
    expect(rollback).toContain('secrets.CLOUDFLARE_API_TOKEN')
    expect(rollback).toContain('needs.deploy.outputs.previous_worker_version')
    expect(rollback).toContain('needs.deploy.outputs.previous_worker_sha')
    expect(rollback).toContain('PREVIOUS_WORKER_SHA:')
    expect(rollback).toContain('needs.deploy.outputs.worker_version')
    expect(rollback).toContain('needs.deploy-smoke.outputs.outcome')
    expect(rollback).toContain('needs.deploy-smoke.outputs.failedStep')
    expect(rollback).toContain('needs.deploy-smoke.outputs.errorKind')
    expect(rollback).not.toMatch(/run:.*wrangler rollback/)
    expect(rollback).not.toContain('TF_CLOUDFLARE_API_TOKEN')
    expect(rollback).not.toContain('secrets.ROLLBACK')

    const access = readFileSync(join(root, '.github/workflows/access-terraform.yml'), 'utf8')
    expect(access).not.toContain('deploy-rollback')
    expect(access).not.toContain('previous_worker_version')

    const doc = readFileSync(join(root, 'docs/deploy-smoke.md'), 'utf8')
    expect(doc).not.toContain('自動 rollback はしない')
    expect(doc).toContain('[deploy-rollback]')
    expect(doc).toContain('previous_worker_version')
    expect(doc).toContain('previous_worker_sha')
    expect(doc).toContain('deploy-sha=')
    expect(doc).toContain('unknown_diff')
    expect(doc).toContain('CLOUDFLARE_API_TOKEN')
    expect(doc).toContain('Ops の runbook')
    expect(doc).toContain('手順はこの文書に複製しない')
    expect(doc).toContain(ROLLBACK_REVERT_NOTE)

    const output = join(mkdtempSync(join(tmpdir(), 'revision-')), 'output')
    const summary = join(dirname(output), 'summary')
    const env = {
      ...process.env,
      GITHUB_SHA: SHA,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      CLOUDFLARE_API_TOKEN: '',
      CLOUDFLARE_ACCOUNT_ID: '',
    }
    const script = join(root, '.github/scripts/record-deploy-revision.sh')
    const beforeRun = spawnSync('bash', [script, 'before'], { cwd: root, env, encoding: 'utf8' })
    expect(beforeRun.status).toBe(0)
    const beforeOutput = readFileSync(output, 'utf8')
    expect(beforeOutput).toContain('previous_worker_version=unknown')
    expect(beforeOutput).toContain('previous_worker_sha=unknown')
    expect(beforeOutput).not.toMatch(/^worker_version=/m)
    expect(beforeRun.stdout).toContain(`github.sha=${SHA}`)
    expect(beforeRun.stdout).toContain('previousWorkerVersion=unknown')
    expect(beforeRun.stdout).toContain('previousWorkerSha=unknown')
    expect(beforeRun.stdout).not.toMatch(/https?:\/\//)

    const afterOutput = join(dirname(output), 'after')
    const afterRun = spawnSync('bash', [script, 'after'], {
      cwd: root,
      env: { ...env, GITHUB_OUTPUT: afterOutput },
      encoding: 'utf8',
    })
    expect(afterRun.status).toBe(0)
    expect(readFileSync(afterOutput, 'utf8')).toContain('worker_version=unknown')
    expect(readFileSync(afterOutput, 'utf8')).toContain(`github_sha=${SHA}`)
    expect(spawnSync('bash', ['-n', script]).status).toBe(0)
  })
})
