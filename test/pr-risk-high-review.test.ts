import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePrRiskArgs, runPrRiskCli, type PrRiskCliIo } from '../src/pr-risk/cli'
import {
  DEFAULT_REVIEW_BUDGET,
  HIGH_RISK_REVIEW_BOT_LOGIN,
  HIGH_RISK_REVIEW_CHARS_PER_TOKEN,
  HIGH_RISK_REVIEW_COST_CAP_USD,
  HIGH_RISK_REVIEW_FILENAME,
  HIGH_RISK_REVIEW_MAX_TOKENS,
  HIGH_RISK_REVIEW_MODEL,
  HIGH_RISK_REVIEW_PRICING_URL,
  commentRecordsReviewCall,
  estimateReviewCostUsd,
  keepsEarlierReviewCall,
  executeHighRiskReview,
  fitReviewPrompt,
  formatHighRiskReviewComment,
  highRiskReviewEnabled,
  highRiskReviewJson,
  isHighRiskReviewComment,
  isHighRiskReviewTarget,
  reviewJudgmentFromJson,
  type HighRiskReviewRecord,
  type HighRiskReviewRun,
  type ReviewBudget,
  type ReviewJudgment,
} from '../src/pr-risk/review'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const API_KEY = 'or-live-key-should-not-leak'

function judgment(blockers: readonly string[], headSha = HEAD): ReviewJudgment {
  return { headSha, baseSha: BASE, blockers, files: ['src/http/auth.ts'] }
}

function run(partial: Partial<HighRiskReviewRun> & Pick<HighRiskReviewRun, 'fetchImpl'>): HighRiskReviewRun {
  return {
    judgment: judgment(['hard_rule']),
    eventHeadSha: HEAD,
    paths: ['src/http/auth.ts'],
    diff: 'diff --git a/src/http/auth.ts\n-checkToken()\n',
    reviewSwitch: null,
    apiKey: API_KEY,
    recordedAt: '2026-10-05T00:00:00.000Z',
    budget: DEFAULT_REVIEW_BUDGET,
    ...partial,
  }
}

function reviewResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('high-risk review routing', () => {
  it('treats only hard_rule and jev_high as high', () => {
    expect(isHighRiskReviewTarget(['hard_rule'])).toBe(true)
    expect(isHighRiskReviewTarget(['jev_high'])).toBe(true)
    expect(isHighRiskReviewTarget(['hard_rule', 'jev_failed'])).toBe(true)
    for (const blockers of [
      [],
      ['incomplete_input'],
      ['jev_skipped'],
      ['jev_failed'],
      ['low_confidence'],
      ['noul_high'],
      ['incomplete_input', 'noul_high', 'low_confidence'],
    ]) {
      expect(isHighRiskReviewTarget(blockers), blockers.join(',')).toBe(false)
    }
  })

  it('treats only the off switch as disabled', () => {
    expect(highRiskReviewEnabled(null)).toBe(true)
    expect(highRiskReviewEnabled('')).toBe(true)
    expect(highRiskReviewEnabled('on')).toBe(true)
    expect(highRiskReviewEnabled('off')).toBe(false)
    expect(highRiskReviewEnabled(' OFF ')).toBe(false)
  })

  it('does not call the API when the switch is off or the key is missing', async () => {
    const fetchImpl = async () => {
      throw new Error('API must not be called')
    }
    const off = await executeHighRiskReview(run({ reviewSwitch: 'off', fetchImpl }))
    expect(off.status).toBe('off')
    expect(off.called).toBe(false)
    expect(off.reason).toContain('off')

    const missing = await executeHighRiskReview(run({ apiKey: null, fetchImpl }))
    expect(missing.status).toBe('missing_key')
    expect(missing.called).toBe(false)
    const blank = await executeHighRiskReview(run({ apiKey: '  ', fetchImpl }))
    expect(blank.status).toBe('missing_key')
    expect(blank.called).toBe(false)
  })

  it('does not call the API for fail-safe additional_review or low risk', async () => {
    const fetchImpl = async () => {
      throw new Error('API must not be called')
    }
    for (const blockers of [
      [],
      ['noul_high'],
      ['low_confidence'],
      ['incomplete_input'],
      ['jev_skipped'],
      ['jev_failed'],
      ['incomplete_input', 'noul_high'],
    ]) {
      const record = await executeHighRiskReview(run({ judgment: judgment(blockers), fetchImpl }))
      expect(record.status, blockers.join(',')).toBe('out_of_scope')
      expect(record.called, blockers.join(',')).toBe(false)
      expect(record.reason).toContain('対象外')
    }
  })

  it('calls the API once for a high judgment and records usage', async () => {
    let calls = 0
    const record = await executeHighRiskReview(
      run({
        fetchImpl: async (_input, init) => {
          calls += 1
          if (calls > 1) {
            throw new Error('retry')
          }
          const body = JSON.parse(String(init?.body)) as {
            model: string
            max_tokens: number
            reasoning: { effort: string }
            messages: { role: string; content: string }[]
          }
          expect(body.model).toBe(HIGH_RISK_REVIEW_MODEL)
          expect(body.max_tokens).toBe(HIGH_RISK_REVIEW_MAX_TOKENS)
          expect(body.reasoning.effort).toBe('low')
          expect(body.messages.map((message) => message.role)).toEqual(['system', 'user'])
          const user = body.messages[1]?.content ?? ''
          expect(user).toContain('src/http/auth.ts')
          expect(user).toContain('checkToken')
          expect(user).not.toContain(API_KEY)
          expect(JSON.stringify(body)).not.toContain(API_KEY)
          const headers = new Headers(init?.headers)
          expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`)
          return reviewResponse(
            JSON.stringify({
              findings: [
                {
                  location: 'src/http/auth.ts',
                  evidence: 'checkToken() が削除されている',
                  detail: '認証の確認が外れている',
                },
              ],
            }),
          )
        },
      }),
    )
    expect(calls).toBe(1)
    expect(record.status).toBe('reviewed')
    expect(record.called).toBe(true)
    expect(record.headSha).toBe(HEAD)
    expect(record.inputTokens).toBe(100)
    expect(record.outputTokens).toBe(40)
    expect(record.estimatedCostUsd).toBe(estimateReviewCostUsd(100, 40, DEFAULT_REVIEW_BUDGET))
    expect(record.findings).toEqual([
      {
        location: 'src/http/auth.ts',
        evidence: 'checkToken() が削除されている',
        detail: '認証の確認が外れている',
      },
    ])
    const comment = formatHighRiskReviewComment(record)
    expect(isHighRiskReviewComment(comment)).toBe(true)
    expect(comment).toContain('マージの可否は変えません')
    expect(comment).toContain('`src/http/auth.ts`')
    expect(comment).toContain('checkToken() が削除されている')
    expect(comment).toContain(HIGH_RISK_REVIEW_MODEL)
    expect(comment).toContain(HEAD)
    expect(comment).not.toContain('指摘はありません')
  })

  it('says there are no findings, with the SHA, when the model returns none', async () => {
    const record = await executeHighRiskReview(
      run({
        judgment: judgment(['jev_high']),
        fetchImpl: async () => reviewResponse(JSON.stringify({ findings: [] })),
      }),
    )
    expect(record.status).toBe('reviewed')
    expect(record.findings).toEqual([])
    const comment = formatHighRiskReviewComment(record)
    expect(comment).toContain(`指摘はありません（head SHA \`${HEAD}\`）`)
    expect(comment).toContain('マージの可否は変えません')
  })

  it('records empty model output separately from no findings', async () => {
    const record = await executeHighRiskReview(
      run({
        fetchImpl: async () => reviewResponse('   '),
      }),
    )
    expect(record.status).toBe('empty_output')
    expect(record.called).toBe(true)
    expect(record.findings).toEqual([])
    const comment = formatHighRiskReviewComment(record)
    expect(comment).toContain(`モデル出力が空でした（head SHA \`${HEAD}\`）`)
    expect(comment).toContain('指摘としては扱っていません')
    expect(comment).not.toContain('指摘はありません')
  })

  it('records unparseable model output separately from no findings', async () => {
    const record = await executeHighRiskReview(
      run({
        fetchImpl: async () => reviewResponse('not json at all'),
      }),
    )
    expect(record.status).toBe('unparseable')
    expect(record.called).toBe(true)
    expect(record.findings).toEqual([])
    const comment = formatHighRiskReviewComment(record)
    expect(comment).toContain(`モデル出力を指摘として読めませんでした（head SHA \`${HEAD}\`）`)
    expect(comment).not.toContain('指摘はありません')
  })

  it('marks valid JSON as unparseable when every finding is discarded', async () => {
    const record = await executeHighRiskReview(
      run({
        fetchImpl: async () =>
          reviewResponse(
            JSON.stringify({
              findings: [
                { location: '', evidence: 'something', detail: 'x' },
                { location: 'src/http/auth.ts', evidence: '  ', detail: 'x' },
                null,
                'not-an-object',
                { location: 1, evidence: 'shape is wrong' },
              ],
            }),
          ),
      }),
    )
    expect(record.status).toBe('unparseable')
    expect(record.called).toBe(true)
    expect(record.findings).toEqual([])
    const comment = formatHighRiskReviewComment(record)
    expect(comment).toContain(`モデル出力を指摘として読めませんでした（head SHA \`${HEAD}\`）`)
    expect(comment).not.toContain('指摘はありません')
  })

  it('keeps valid findings when other findings are discarded', async () => {
    const record = await executeHighRiskReview(
      run({
        fetchImpl: async () =>
          reviewResponse(
            JSON.stringify({
              findings: [
                { location: '', evidence: 'drop me' },
                {
                  location: 'src/http/auth.ts',
                  evidence: 'checkToken() が削除されている',
                  detail: '残す',
                },
                null,
              ],
            }),
          ),
      }),
    )
    expect(record.status).toBe('reviewed')
    expect(record.findings).toEqual([
      {
        location: 'src/http/auth.ts',
        evidence: 'checkToken() が削除されている',
        detail: '残す',
      },
    ])
    expect(formatHighRiskReviewComment(record)).not.toContain('指摘はありません')
  })

  it('truncates an over-cap diff and still makes one call', async () => {
    const paths = ['src/http/auth.ts']
    const loose: ReviewBudget = {
      inputUsdPerToken: 1,
      outputUsdPerToken: 0,
      maxOutputTokens: 0,
      costCapUsd: 1_000_000,
      charsPerToken: 1,
      framingTokens: 0,
    }
    const probe = fitReviewPrompt({ paths, diff: 'Z', budget: loose })
    const overhead = probe.inputTokens - 1
    const diff = `sk-supersecretvalue123\nHEAD_KEEP\n${'x'.repeat(4000)}\nTAIL_CUT`
    const tight: ReviewBudget = { ...loose, costCapUsd: overhead + 200 }
    const fitted = fitReviewPrompt({ paths, diff, budget: tight })
    expect(fitted.skip).toBe(false)
    expect(fitted.truncatedForCost).toBe(true)
    expect(fitted.user).toContain('HEAD_KEEP')
    expect(fitted.user).not.toContain('TAIL_CUT')
    expect(fitted.user).not.toContain('sk-supersecretvalue123')
    expect(fitted.user).toContain('[REDACTED]')
    expect(fitted.preCallCostUsd).toBeLessThanOrEqual(tight.costCapUsd)

    let calls = 0
    const record = await executeHighRiskReview(
      run({
        budget: tight,
        diff,
        paths,
        fetchImpl: async (_input, init) => {
          calls += 1
          const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
          const user = body.messages[1]?.content ?? ''
          expect(user).toContain('HEAD_KEEP')
          expect(user).not.toContain('TAIL_CUT')
          expect(user).not.toContain('sk-supersecretvalue123')
          expect(user).not.toContain(API_KEY)
          return reviewResponse(JSON.stringify({ findings: [] }))
        },
      }),
    )
    expect(calls).toBe(1)
    expect(record.called).toBe(true)
    expect(record.truncatedForCost).toBe(true)
    expect(record.preCallCostUsd).toBeLessThanOrEqual(tight.costCapUsd)
  })

  it('skips the call when even the fixed prompt exceeds the cap', async () => {
    let calls = 0
    const budget: ReviewBudget = {
      inputUsdPerToken: 1,
      outputUsdPerToken: 1,
      maxOutputTokens: 10,
      costCapUsd: 1,
      charsPerToken: 1,
      framingTokens: 0,
    }
    const fitted = fitReviewPrompt({ paths: ['src/http/auth.ts'], diff: 'x'.repeat(100), budget })
    expect(fitted.skip).toBe(true)
    expect(fitted.preCallCostUsd).toBeGreaterThan(budget.costCapUsd)
    const record = await executeHighRiskReview(
      run({
        budget,
        fetchImpl: async () => {
          calls += 1
          throw new Error('API must not be called')
        },
      }),
    )
    expect(calls).toBe(0)
    expect(record.status).toBe('skipped_cost')
    expect(record.called).toBe(false)
    expect(record.reason).toContain(String(budget.costCapUsd))
  })

  it('keeps a normal diff under the published cap and truncates a huge one', () => {
    const small = fitReviewPrompt({
      paths: ['README.md'],
      diff: '+typo\n',
      budget: DEFAULT_REVIEW_BUDGET,
    })
    expect(small.skip).toBe(false)
    expect(small.truncatedForCost).toBe(false)
    expect(small.preCallCostUsd).toBeLessThanOrEqual(HIGH_RISK_REVIEW_COST_CAP_USD)

    const huge = fitReviewPrompt({
      paths: ['src/http/auth.ts'],
      diff: 'y'.repeat(400_000),
      budget: DEFAULT_REVIEW_BUDGET,
    })
    expect(huge.skip).toBe(false)
    expect(huge.truncatedForCost).toBe(true)
    expect(huge.diffCharsSent).toBeLessThan(400_000)
    expect(huge.preCallCostUsd).toBeLessThanOrEqual(HIGH_RISK_REVIEW_COST_CAP_USD)
    const gate = estimateReviewCostUsd(huge.inputTokens, HIGH_RISK_REVIEW_MAX_TOKENS, DEFAULT_REVIEW_BUDGET)
    expect(gate).toBeLessThanOrEqual(HIGH_RISK_REVIEW_COST_CAP_USD)
  })

  it('does not fail the job when the API fails, and does not retry', async () => {
    let calls = 0
    const http = await executeHighRiskReview(
      run({
        fetchImpl: async () => {
          calls += 1
          return new Response('no', { status: 503 })
        },
      }),
    )
    expect(calls).toBe(1)
    expect(http.status).toBe('api_error')
    expect(http.called).toBe(true)
    expect(http.reason).toContain('503')
    expect(http.reason).not.toContain(API_KEY)
    expect(formatHighRiskReviewComment(http)).toContain(HEAD)

    const thrown = await executeHighRiskReview(
      run({
        fetchImpl: async () => {
          throw new Error('network down')
        },
      }),
    )
    expect(thrown.status).toBe('api_error')
    expect(thrown.called).toBe(true)
    expect(thrown.reason).not.toContain(API_KEY)
  })

  it('invalidates a judgment whose head SHA is not the commit under review', async () => {
    const record = await executeHighRiskReview(
      run({
        eventHeadSha: OTHER,
        fetchImpl: async () => {
          throw new Error('API must not be called')
        },
      }),
    )
    expect(record.status).toBe('stale_judgment')
    expect(record.headSha).toBe(OTHER)
    expect(record.called).toBe(false)
    expect(record.reason).toContain(HEAD)
    expect(record.reason).toContain(OTHER)
  })

  it('redacts secrets echoed in a finding before commenting', () => {
    const record = reviewedRecord({
      findings: [
        {
          location: 'src/http/auth.ts',
          evidence: 'key sk-supersecretvalue123 was committed',
          detail: 'remove it',
        },
      ],
    })
    const comment = formatHighRiskReviewComment(record)
    expect(comment).not.toContain('sk-supersecretvalue123')
    expect(comment).toContain('[REDACTED]')
    expect(comment).toContain('src/http/auth.ts')
  })

  it('redacts secret-like values in the review artifact the same way as the comment', () => {
    const record = reviewedRecord({
      reason: 'saw sk-supersecretvalue123 in the diff',
      findings: [
        {
          location: 'src/http/auth.ts',
          evidence: 'key sk-supersecretvalue123 was committed',
          detail: 'remove it',
        },
      ],
    })
    const json = highRiskReviewJson(record)
    expect(json).not.toContain('sk-supersecretvalue123')
    expect(json).toContain('[REDACTED]')
    expect(json).toContain('src/http/auth.ts')
    expect(JSON.parse(json)).toMatchObject({ status: 'reviewed', headSha: HEAD })
  })

  it('counts a call only when github-actions[bot] already recorded this SHA', () => {
    const called = formatHighRiskReviewComment(
      reviewedRecord({
        findings: [{ location: 'src/http/auth.ts', evidence: 'checkToken() が削除されている', detail: '' }],
      }),
    )
    const bot = { body: called, authorLogin: HIGH_RISK_REVIEW_BOT_LOGIN }
    expect(commentRecordsReviewCall(bot, HEAD)).toBe(true)
    expect(commentRecordsReviewCall(bot, OTHER)).toBe(false)
    expect(commentRecordsReviewCall({ body: called, authorLogin: 'marufeuille' }, HEAD)).toBe(false)
    expect(commentRecordsReviewCall({ body: called, authorLogin: 'github-actions' }, HEAD)).toBe(false)
    expect(commentRecordsReviewCall({ body: called, authorLogin: null }, HEAD)).toBe(false)
    const notCalled = formatHighRiskReviewComment(
      reviewedRecord({ status: 'out_of_scope', called: false, reason: '対象外です。' }),
    )
    expect(commentRecordsReviewCall({ body: notCalled, authorLogin: HIGH_RISK_REVIEW_BOT_LOGIN }, HEAD)).toBe(false)
    expect(keepsEarlierReviewCall('off', HEAD, [bot])).toBe(true)
    expect(keepsEarlierReviewCall('out_of_scope', HEAD, [bot])).toBe(true)
    expect(keepsEarlierReviewCall('off', OTHER, [bot])).toBe(false)
    expect(keepsEarlierReviewCall('off', HEAD, [{ body: called, authorLogin: 'marufeuille' }])).toBe(false)
    expect(keepsEarlierReviewCall('reviewed', HEAD, [bot])).toBe(false)
    expect(keepsEarlierReviewCall('missing_key', HEAD, [bot])).toBe(false)
  })

  it('still calls the API when only a person posted the call marker', async () => {
    const body = formatHighRiskReviewComment(
      reviewedRecord({
        findings: [{ location: 'src/http/auth.ts', evidence: 'planted', detail: '' }],
      }),
    )
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return reviewResponse(JSON.stringify({ findings: [] }))
    }
    for (const authorLogin of ['marufeuille', 'github-actions', null] as const) {
      calls = 0
      const record = await executeHighRiskReview(
        run({
          fetchImpl,
          priorComments: [{ body, authorLogin }],
        }),
      )
      expect(record.status, String(authorLogin)).toBe('reviewed')
      expect(record.called, String(authorLogin)).toBe(true)
      expect(calls, String(authorLogin)).toBe(1)
    }
    calls = 0
    const skipped = await executeHighRiskReview(
      run({
        fetchImpl,
        priorComments: [{ body, authorLogin: HIGH_RISK_REVIEW_BOT_LOGIN }],
      }),
    )
    expect(skipped.status).toBe('already_called')
    expect(skipped.called).toBe(false)
    expect(calls).toBe(0)
  })
})

describe('high-risk review CLI', () => {
  it('parses review args', () => {
    expect(parsePrRiskArgs(['review', '--no-comment', '--judgment', 'in.json', '--output', 'out.json'])).toEqual({
      command: 'review',
      noComment: true,
      judgmentPath: 'in.json',
      output: 'out.json',
    })
  })

  it('exits 0 without calling the API when the switch is off, the key is missing, or the PR is not high', async () => {
    for (const env of [
      { HIGH_RISK_REVIEW: 'off', OPENROUTER_API_KEY: API_KEY, blockers: ['hard_rule'] },
      { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: '', blockers: ['hard_rule'] },
      { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers: ['noul_high', 'low_confidence'] },
    ]) {
      let calls = 0
      const files = new Map<string, string>()
      const code = await runPrRiskCli(
        reviewIo({
          env,
          files,
          comment: false,
          fetchImpl: async () => {
            calls += 1
            throw new Error('API must not be called')
          },
        }),
      )
      expect(code, JSON.stringify(env)).toBe(0)
      expect(calls, JSON.stringify(env)).toBe(0)
      const written = JSON.parse(files.get(HIGH_RISK_REVIEW_FILENAME) ?? '{}') as HighRiskReviewRecord
      expect(written.called).toBe(false)
      if (env.HIGH_RISK_REVIEW === 'off') {
        expect(written.status).toBe('off')
      } else if (env.OPENROUTER_API_KEY === '') {
        expect(written.status).toBe('missing_key')
      } else {
        expect(written.status).toBe('out_of_scope')
        expect(written.reason).toContain('対象外')
      }
    }
  })

  it('exits 0 when the API fails', async () => {
    let calls = 0
    const files = new Map<string, string>()
    const code = await runPrRiskCli(
      reviewIo({
        env: { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers: ['jev_high'] },
        files,
        comment: false,
        fetchImpl: async () => {
          calls += 1
          if (calls > 1) {
            throw new Error('retry')
          }
          return new Response('bad gateway', { status: 502 })
        },
      }),
    )
    expect(code).toBe(0)
    expect(calls).toBe(1)
    const written = JSON.parse(files.get(HIGH_RISK_REVIEW_FILENAME) ?? '{}') as HighRiskReviewRecord
    expect(written.status).toBe('api_error')
    expect(written.called).toBe(true)
    expect(written.headSha).toBe(HEAD)
  })

  it('reruns on a new commit and replaces the comment for the previous SHA', async () => {
    const comments: IssueComment[] = []
    let openRouterCalls = 0
    const files = new Map<string, string>()
    let head = HEAD
    let blockers = ['hard_rule']
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('openrouter.ai')) {
        openRouterCalls += 1
        const content =
          head === HEAD
            ? JSON.stringify({
                findings: [{ location: 'src/http/auth.ts', evidence: 'first finding', detail: 'first' }],
              })
            : JSON.stringify({ findings: [] })
        return reviewResponse(content)
      }
      if (url.endsWith('/issues/69/comments?per_page=100&page=1') && init?.method === 'GET') {
        return Response.json(comments)
      }
      if (url.endsWith('/issues/69/comments') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { body: string }
        comments.push(asBotComment(9, body.body))
        return Response.json({ id: 9 })
      }
      if (url.endsWith('/issues/comments/9') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { body: string }
        const existing = comments[0]
        if (existing === undefined) {
          throw new Error('missing comment')
        }
        comments[0] = asBotComment(existing.id, body.body)
        return Response.json({ id: 9 })
      }
      throw new Error(`${init?.method ?? 'GET'} ${url}`)
    }

    const io = (sha: string): PrRiskCliIo =>
      reviewIo({
        env: { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers },
        files,
        fetchImpl,
        headSha: sha,
      })

    expect(await runPrRiskCli(io(HEAD))).toBe(0)
    expect(openRouterCalls).toBe(1)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain(HEAD)
    expect(comments[0]?.body).toContain('first finding')

    head = OTHER
    blockers = ['jev_high']
    expect(await runPrRiskCli(io(OTHER))).toBe(0)
    expect(openRouterCalls).toBe(2)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain(OTHER)
    expect(comments[0]?.body).not.toContain(HEAD)
    expect(comments[0]?.body).toContain(`指摘はありません（head SHA \`${OTHER}\`）`)
    expect(comments[0]?.body).not.toContain('first finding')

    head = 'd'.repeat(40)
    blockers = ['noul_high']
    expect(await runPrRiskCli(io(head))).toBe(0)
    expect(openRouterCalls).toBe(2)
    expect(comments[0]?.body).toContain('対象外')
    expect(comments[0]?.body).toContain(head)
    expect(comments[0]?.body).not.toContain(OTHER)
  })

  it('second run on the same SHA does not call the API', async () => {
    const comments: IssueComment[] = []
    let openRouterCalls = 0
    let commentWrites = 0
    const files = new Map<string, string>()
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('openrouter.ai')) {
        openRouterCalls += 1
        return reviewResponse(
          JSON.stringify({
            findings: [{ location: 'src/http/auth.ts', evidence: 'first finding', detail: 'first' }],
          }),
        )
      }
      if (url.endsWith('/issues/69/comments?per_page=100&page=1') && init?.method === 'GET') {
        return Response.json(comments)
      }
      if (url.endsWith('/issues/69/comments') && init?.method === 'POST') {
        commentWrites += 1
        const body = JSON.parse(String(init.body)) as { body: string }
        comments.push(asBotComment(9, body.body))
        return Response.json({ id: 9 })
      }
      if (url.includes('/issues/comments/') && (init?.method === 'PATCH' || init?.method === 'POST')) {
        commentWrites += 1
        throw new Error('must not replace the call record')
      }
      throw new Error(`${init?.method ?? 'GET'} ${url}`)
    }
    const io = (): PrRiskCliIo =>
      reviewIo({
        env: { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers: ['hard_rule'] },
        files,
        fetchImpl,
      })

    expect(await runPrRiskCli(io())).toBe(0)
    expect(openRouterCalls).toBe(1)
    expect(commentWrites).toBe(1)
    const first = comments[0]?.body ?? ''
    expect(first).toContain(`sha=${HEAD} `)
    expect(first).toContain('| API | 呼んだ |')
    expect(first).toContain('first finding')

    expect(await runPrRiskCli(io())).toBe(0)
    expect(openRouterCalls).toBe(1)
    expect(commentWrites).toBe(1)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toBe(first)
    const written = JSON.parse(files.get(HIGH_RISK_REVIEW_FILENAME) ?? '{}') as HighRiskReviewRecord
    expect(written.status).toBe('already_called')
    expect(written.called).toBe(false)
    expect(written.reason).toContain('再度は呼びません')
  })

  it('calls the API when a person posted the marker and leaves that comment alone', async () => {
    const planted = formatHighRiskReviewComment(
      reviewedRecord({
        findings: [{ location: 'src/http/auth.ts', evidence: 'planted', detail: '' }],
      }),
    )
    const comments: IssueComment[] = [
      { id: 3, body: planted, user: { login: 'marufeuille' } },
      { id: 4, body: planted },
    ]
    let openRouterCalls = 0
    const files = new Map<string, string>()
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('openrouter.ai')) {
        openRouterCalls += 1
        return reviewResponse(
          JSON.stringify({
            findings: [{ location: 'src/http/auth.ts', evidence: 'from the model', detail: 'real' }],
          }),
        )
      }
      if (url.endsWith('/issues/69/comments?per_page=100&page=1') && init?.method === 'GET') {
        return Response.json(comments)
      }
      if (url.endsWith('/issues/69/comments') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { body: string }
        comments.push(asBotComment(9, body.body))
        return Response.json({ id: 9 })
      }
      if (init?.method === 'PATCH') {
        throw new Error('must not edit a person comment')
      }
      throw new Error(`${init?.method ?? 'GET'} ${url}`)
    }
    const io = (): PrRiskCliIo =>
      reviewIo({
        env: { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers: ['hard_rule'] },
        files,
        fetchImpl,
      })

    expect(await runPrRiskCli(io())).toBe(0)
    expect(openRouterCalls).toBe(1)
    expect(comments[0]?.body).toBe(planted)
    expect(comments[1]?.body).toBe(planted)
    expect(comments[2]?.user?.login).toBe(HIGH_RISK_REVIEW_BOT_LOGIN)
    expect(comments[2]?.body).toContain('from the model')
    expect(comments[2]?.body).toContain('| API | 呼んだ |')

    expect(await runPrRiskCli(io())).toBe(0)
    expect(openRouterCalls).toBe(1)
    expect(comments).toHaveLength(3)
    const written = JSON.parse(files.get(HIGH_RISK_REVIEW_FILENAME) ?? '{}') as HighRiskReviewRecord
    expect(written.status).toBe('already_called')
  })

  it('pages past the first 100 comments to find the bot call record', async () => {
    const marker = formatHighRiskReviewComment(
      reviewedRecord({
        findings: [{ location: 'src/http/auth.ts', evidence: 'already', detail: '' }],
      }),
    )
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `note ${index}`,
      user: { login: 'marufeuille' },
    }))
    const page2 = [asBotComment(101, marker)]
    let openRouterCalls = 0
    const seenPages: number[] = []
    const files = new Map<string, string>()
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('openrouter.ai')) {
        openRouterCalls += 1
        throw new Error('API must not be called')
      }
      const page = /\/issues\/69\/comments\?per_page=100&page=(\d+)$/.exec(url)
      if (page !== null && init?.method === 'GET') {
        const number = Number(page[1])
        seenPages.push(number)
        if (number === 1) {
          return Response.json(page1)
        }
        if (number === 2) {
          return Response.json(page2)
        }
        return Response.json([])
      }
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        throw new Error('must not write a comment')
      }
      throw new Error(`${init?.method ?? 'GET'} ${url}`)
    }
    const code = await runPrRiskCli(
      reviewIo({
        env: { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers: ['hard_rule'] },
        files,
        fetchImpl,
      }),
    )
    expect(code).toBe(0)
    expect(seenPages).toEqual([1, 2])
    expect(openRouterCalls).toBe(0)
    const written = JSON.parse(files.get(HIGH_RISK_REVIEW_FILENAME) ?? '{}') as HighRiskReviewRecord
    expect(written.status).toBe('already_called')
    expect(written.called).toBe(false)
  })

  it('updates the bot comment on a later page when the SHA changes', async () => {
    const previous = formatHighRiskReviewComment(
      reviewedRecord({
        headSha: OTHER,
        findings: [{ location: 'src/http/auth.ts', evidence: 'old finding', detail: '' }],
      }),
    )
    const page1 = [
      { id: 1, body: previous, user: { login: 'marufeuille' } },
      ...Array.from({ length: 99 }, (_, index) => ({
        id: index + 2,
        body: `note ${index}`,
        user: { login: 'marufeuille' },
      })),
    ]
    const page2 = [asBotComment(200, previous)]
    let openRouterCalls = 0
    let patchedId: number | null = null
    const files = new Map<string, string>()
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('openrouter.ai')) {
        openRouterCalls += 1
        return reviewResponse(JSON.stringify({ findings: [] }))
      }
      const page = /\/issues\/69\/comments\?per_page=100&page=(\d+)$/.exec(url)
      if (page !== null && init?.method === 'GET') {
        const number = Number(page[1])
        if (number === 1) {
          return Response.json(page1)
        }
        if (number === 2) {
          return Response.json(page2)
        }
        return Response.json([])
      }
      if (url.endsWith('/issues/comments/200') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { body: string }
        patchedId = 200
        page2[0] = asBotComment(200, body.body)
        return Response.json({ id: 200 })
      }
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        throw new Error(`unexpected write ${url}`)
      }
      throw new Error(`${init?.method ?? 'GET'} ${url}`)
    }
    const code = await runPrRiskCli(
      reviewIo({
        env: { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers: ['jev_high'] },
        files,
        fetchImpl,
      }),
    )
    expect(code).toBe(0)
    expect(openRouterCalls).toBe(1)
    expect(patchedId).toBe(200)
    expect(page1[0]?.body).toBe(previous)
    expect(page2[0]?.body).toContain(HEAD)
    expect(page2[0]?.body).toContain(`指摘はありません（head SHA \`${HEAD}\`）`)
    expect(page2[0]?.body).not.toContain('old finding')
  })

  it('keeps the bot call record when a later run on the same SHA is off or out of scope', async () => {
    const marker = formatHighRiskReviewComment(
      reviewedRecord({
        findings: [{ location: 'src/http/auth.ts', evidence: 'keep me', detail: '' }],
      }),
    )
    for (const env of [
      { HIGH_RISK_REVIEW: 'off', OPENROUTER_API_KEY: API_KEY, blockers: ['hard_rule'] },
      { HIGH_RISK_REVIEW: '', OPENROUTER_API_KEY: API_KEY, blockers: ['noul_high'] },
    ]) {
      const comments = [asBotComment(9, marker)]
      let openRouterCalls = 0
      const files = new Map<string, string>()
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input)
        if (url.includes('openrouter.ai')) {
          openRouterCalls += 1
          throw new Error('API must not be called')
        }
        if (url.endsWith('/issues/69/comments?per_page=100&page=1') && init?.method === 'GET') {
          return Response.json(comments)
        }
        if (init?.method === 'POST' || init?.method === 'PATCH') {
          throw new Error('must not replace the call record')
        }
        throw new Error(`${init?.method ?? 'GET'} ${url}`)
      }
      const code = await runPrRiskCli(reviewIo({ env, files, fetchImpl }))
      expect(code, JSON.stringify(env)).toBe(0)
      expect(openRouterCalls, JSON.stringify(env)).toBe(0)
      expect(comments[0]?.body).toBe(marker)
      const written = JSON.parse(files.get(HIGH_RISK_REVIEW_FILENAME) ?? '{}') as HighRiskReviewRecord
      expect(written.called).toBe(false)
      expect(written.status).toBe(env.HIGH_RISK_REVIEW === 'off' ? 'off' : 'out_of_scope')
    }
  })

  it('still writes an off comment when this SHA has no call record', async () => {
    const comments: IssueComment[] = []
    let openRouterCalls = 0
    const files = new Map<string, string>()
    const code = await runPrRiskCli(
      reviewIo({
        env: { HIGH_RISK_REVIEW: 'off', OPENROUTER_API_KEY: API_KEY, blockers: ['hard_rule'] },
        files,
        fetchImpl: async (input, init) => {
          const url = String(input)
          if (url.includes('openrouter.ai')) {
            openRouterCalls += 1
            throw new Error('API must not be called')
          }
          if (url.endsWith('/issues/69/comments?per_page=100&page=1') && init?.method === 'GET') {
            return Response.json(comments)
          }
          if (url.endsWith('/issues/69/comments') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { body: string }
            comments.push(asBotComment(9, body.body))
            return Response.json({ id: 9 })
          }
          throw new Error(`${init?.method ?? 'GET'} ${url}`)
        },
      }),
    )
    expect(code).toBe(0)
    expect(openRouterCalls).toBe(0)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('オフ')
    expect(comments[0]?.body).toContain('| API | 呼んでいない |')
    const written = JSON.parse(files.get(HIGH_RISK_REVIEW_FILENAME) ?? '{}') as HighRiskReviewRecord
    expect(written.status).toBe('off')
  })
})

describe('high-risk review docs', () => {
  it('documents the model, the pricing source, the cap, and the off switch', () => {
    const doc = readFileSync('docs/pr-risk.md', 'utf8')
    expect(doc).toContain(HIGH_RISK_REVIEW_MODEL)
    expect(doc).toContain(HIGH_RISK_REVIEW_PRICING_URL)
    expect(doc).toContain('US$0.30')
    expect(doc).toContain('0.000002')
    expect(doc).toContain('0.00001')
    expect(doc).toContain('1 文字 1 トークン')
    expect(HIGH_RISK_REVIEW_CHARS_PER_TOKEN).toBe(1)
    expect(doc).toContain('HIGH_RISK_REVIEW')
    expect(doc).toContain('hard_rule')
    expect(doc).toContain('jev_high')
    expect(doc).toContain('対象外')
    expect(doc).toContain('https://linear.app/marufeuille/issue/MAR-69')
    expect(doc).toContain('https://linear.app/marufeuille/issue/MAR-182')
    expect(doc).toContain(HIGH_RISK_REVIEW_BOT_LOGIN)
    expect(doc).toContain('指摘が全部無効')
    expect(doc).toContain('最大 10 ページ')
    expect(doc).toContain('オフや対象外')
    expect(doc).toContain('US$2.50')
    expect(doc).toContain('9 件')
    expect(doc).toContain('head SHA の累計ではない')
    expect(doc).not.toContain('1 head SHA')
    expect(estimateReviewCostUsd(0, HIGH_RISK_REVIEW_MAX_TOKENS, DEFAULT_REVIEW_BUDGET)).toBeLessThan(
      HIGH_RISK_REVIEW_COST_CAP_USD,
    )
  })
})

type IssueComment = {
  id: number
  body: string
  user?: { login: string }
}

function asBotComment(id: number, body: string): IssueComment {
  return { id, body, user: { login: HIGH_RISK_REVIEW_BOT_LOGIN } }
}

function reviewedRecord(partial: Partial<HighRiskReviewRecord>): HighRiskReviewRecord {
  return {
    headSha: HEAD,
    baseSha: BASE,
    status: 'reviewed',
    called: true,
    model: HIGH_RISK_REVIEW_MODEL,
    pricingUrl: HIGH_RISK_REVIEW_PRICING_URL,
    inputUsdPerToken: DEFAULT_REVIEW_BUDGET.inputUsdPerToken,
    outputUsdPerToken: DEFAULT_REVIEW_BUDGET.outputUsdPerToken,
    maxTokens: HIGH_RISK_REVIEW_MAX_TOKENS,
    costCapUsd: HIGH_RISK_REVIEW_COST_CAP_USD,
    inputTokens: 10,
    outputTokens: 4,
    estimatedCostUsd: 0.00006,
    preCallCostUsd: 0.02,
    diffCharsSent: 20,
    truncatedForCost: false,
    findings: [],
    reason: '指摘はありません。',
    recordedAt: '2026-10-05T00:00:00.000Z',
    ...partial,
  }
}

function reviewIo(input: {
  readonly env: { readonly HIGH_RISK_REVIEW: string; readonly OPENROUTER_API_KEY: string; readonly blockers: readonly string[] }
  readonly files: Map<string, string>
  readonly fetchImpl: typeof fetch
  readonly headSha?: string
  readonly comment?: boolean
}): PrRiskCliIo {
  const headSha = input.headSha ?? HEAD
  return {
    argv: input.comment === false ? ['review', '--no-comment'] : ['review'],
    env: {
      GITHUB_EVENT_PATH: '/event.json',
      GITHUB_REPOSITORY: 'marufeuille/xteink-read-later',
      GITHUB_TOKEN: 'gh-token',
      HIGH_RISK_REVIEW: input.env.HIGH_RISK_REVIEW,
      OPENROUTER_API_KEY: input.env.OPENROUTER_API_KEY,
    },
    stdout: { write() {} },
    stderr: { write() {} },
    readFile: async (path) => {
      if (path === '/event.json') {
        return JSON.stringify({
          pull_request: {
            number: 69,
            title: 'MAR-69',
            body: '',
            head: { sha: headSha, ref: 'cursor/mar-69' },
            base: { sha: BASE, ref: 'main' },
          },
        })
      }
      if (path === 'pr-risk-judgment.json') {
        return JSON.stringify({
          headSha,
          baseSha: BASE,
          blockers: input.env.blockers,
          input: { files: ['src/http/auth.ts'] },
        })
      }
      throw new Error(path)
    },
    writeFile: async (path, contents) => {
      input.files.set(path, contents)
    },
    execGit: async () => 'diff --git a/src/http/auth.ts b/src/http/auth.ts\n-checkToken()\n',
    fetch: input.fetchImpl,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
  }
}

describe('stored pr-risk judgment', () => {
  it('reads blockers and ignores a judgment that is not an object', () => {
    expect(reviewJudgmentFromJson({
      headSha: HEAD,
      baseSha: BASE,
      blockers: ['hard_rule', 'noul_high'],
      input: { files: ['src/http/auth.ts', 1] },
    })).toEqual({
      headSha: HEAD,
      baseSha: BASE,
      blockers: ['hard_rule', 'noul_high'],
      files: ['src/http/auth.ts'],
    })
    expect(reviewJudgmentFromJson({ headSha: HEAD })).toBeNull()
    expect(reviewJudgmentFromJson(null)).toBeNull()
  })
})
