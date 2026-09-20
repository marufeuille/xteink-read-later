import { describe, expect, it, vi } from 'vitest'
import {
  parsePrRiskArgs,
  PR_RISK_USAGE,
  runPrRiskCli,
  type PrRiskCliIo,
} from '../src/pr-risk/cli'
import { isPrRiskComment } from '../src/pr-risk/comment'
import { ok, type EvaluateSystemOne } from '../src/types'

function evaluateLow(): EvaluateSystemOne {
  return async () =>
    ok({
      model: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 2 },
      answers: {
        change_risk: {
          type: 'choice',
          choice: 'low',
          confidence: 0.96,
          probabilities: { low: 0.97, high: 0.03 },
        },
        touches_auth: { type: 'noul', noul: 0.01 },
        touches_secrets: { type: 'noul', noul: 0.01 },
        touches_data_lifecycle: { type: 'noul', noul: 0.01 },
        touches_ci_deploy_rules: { type: 'noul', noul: 0.01 },
      },
    })
}

describe('pr-risk CLI', () => {
  it('parses github and replay args', () => {
    expect(parsePrRiskArgs(['github', '--no-comment', '--output', 'out.json'])).toEqual({
      command: 'github',
      noComment: true,
      output: 'out.json',
    })
    expect(parsePrRiskArgs(['replay', '--limit', '5', '--pr', '31,35'])).toEqual({
      command: 'replay',
      limit: 5,
      prs: [31, 35],
    })
    expect(parsePrRiskArgs([])).toMatchObject({ error: PR_RISK_USAGE })
    expect(parsePrRiskArgs(['github', '--wat'])).toMatchObject({ error: expect.stringContaining('不明なオプション') })
  })

  it('classifies a GitHub event, writes the SHA judgment, and upserts the trial comment', async () => {
    const files = new Map<string, string>()
    const comments: { id: number; body: string }[] = []
    const io: PrRiskCliIo = {
      argv: ['github'],
      env: {
        GITHUB_EVENT_PATH: '/event.json',
        GITHUB_REPOSITORY: 'marufeuille/xteink-read-later',
        GITHUB_TOKEN: 'gh-token',
        OPENROUTER_API_KEY: 'or-test',
      },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      readFile: async (path) => {
        if (path === '/event.json') {
          return JSON.stringify({
            pull_request: {
              number: 60,
              title: 'MAR-60 docs',
              body: '記録のみ',
              head: { sha: 'headsha', ref: 'cursor/mar-60-jev-pr-risk' },
              base: { sha: 'basesha', ref: 'main' },
            },
          })
        }
        throw new Error(path)
      },
      writeFile: async (path, contents) => {
        files.set(path, contents)
      },
      execGit: async (args) => {
        const joined = args.join(' ')
        if (joined.includes('--name-status')) {
          return 'M\tREADME.md\n'
        }
        if (joined.includes('--numstat')) {
          return '2\t0\tREADME.md\n'
        }
        return 'diff --git a/README.md b/README.md\n+hello\n'
      },
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/issues/60/comments?per_page=100') && init?.method === 'GET') {
          return Response.json(comments)
        }
        if (url.endsWith('/issues/60/comments') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { body: string }
          comments.push({ id: 7, body: body.body })
          return Response.json({ id: 7 })
        }
        throw new Error(url)
      },
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      evaluate: evaluateLow(),
    }

    expect(await runPrRiskCli(io)).toBe(0)
    const written = files.get('pr-risk-judgment.json')
    expect(written).toBeTruthy()
    const judgment = JSON.parse(String(written)) as { headSha: string; recommendedRoute: string }
    expect(judgment.headSha).toBe('headsha')
    expect(judgment.recommendedRoute).toBe('low_risk')
    expect(comments).toHaveLength(1)
    expect(isPrRiskComment(comments[0]?.body ?? '')).toBe(true)
    expect(comments[0]?.body).toContain('headsha')
  })

  it('replays a merged PR and reports hard-rule misses as zero when routing holds', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const io: PrRiskCliIo = {
      argv: ['replay', '--pr', '10'],
      env: {
        GITHUB_REPOSITORY: 'marufeuille/xteink-read-later',
        GITHUB_TOKEN: 'gh-token',
        OPENROUTER_API_KEY: 'or-test',
      },
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      readFile: async () => '',
      writeFile: async () => undefined,
      execGit: async () => '',
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith('/pulls/10') && !url.includes('files')) {
          return new Response(
            JSON.stringify({
              number: 10,
              title: 'MAR-38 auth',
              body: '認証を入れる',
              merged_at: '2026-09-19T08:12:21Z',
              head: { sha: 'authhead' },
              base: { sha: 'authbase' },
            }),
            { headers: { 'Content-Type': url.includes('diff') ? 'text/plain' : 'application/json' } },
          )
        }
        if (url.includes('/pulls/10/files')) {
          return Response.json([{ filename: 'src/http/auth.ts', status: 'modified', additions: 20, deletions: 0 }])
        }
        throw new Error(url)
      },
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      evaluate: evaluateLow(),
    }

    const originalFetch = io.fetch
    const wrapped: PrRiskCliIo = {
      ...io,
      fetch: async (input, init) => {
        const url = String(input)
        const accept = new Headers(init?.headers).get('Accept') ?? ''
        if (url.endsWith('/pulls/10') && accept.includes('diff')) {
          return new Response('diff --git a/src/http/auth.ts\n+token')
        }
        return originalFetch(input, init)
      },
    }

    expect(await runPrRiskCli(wrapped)).toBe(0)
    expect(stderr.join('')).toContain('hard_rule_misses=0')
    expect(stdout.join('')).toContain('"recommendedRoute":"additional_review"')
  })
})
