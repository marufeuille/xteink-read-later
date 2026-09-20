import { describe, expect, it } from 'vitest'
import { formatPrRiskComment, isPrRiskComment, judgmentMarker } from '../src/pr-risk/comment'
import { applyNumstat, parseNameStatus } from '../src/pr-risk/git'
import { trialSummary } from '../src/pr-risk/replay'
import type { PrRiskJudgment } from '../src/types'

function judgment(partial: Partial<PrRiskJudgment> = {}): PrRiskJudgment {
  return {
    trialAction: 'record_only',
    ruleVersion: 'pr-risk-v1',
    headSha: 'abc123',
    baseSha: 'def456',
    prNumber: 60,
    recordedAt: '2026-09-20T00:00:00.000Z',
    input: {
      files: ['README.md'],
      testFiles: [],
      fileCount: 1,
      diffChars: 12,
      bodyChars: 8,
      truncated: false,
      missingDiff: false,
      linearIds: ['MAR-60'],
      linearAcceptancePresent: true,
    },
    hardRules: { matched: false, reasons: [], files: [] },
    jev: {
      model: 'jev-1.13.0',
      durationMs: 120,
      inputTokens: 800,
      changeRisk: { choice: 'low', confidence: 0.96, probabilities: { low: 0.97, high: 0.03 } },
      touchesAuth: 0.01,
      touchesSecrets: 0.01,
      touchesDataLifecycle: 0.01,
      touchesCiDeployRules: 0.01,
    },
    jevError: null,
    recommendedRoute: 'low_risk',
    blockers: [],
    ...partial,
  }
}

describe('pr-risk comment and git', () => {
  it('embeds the SHA and refuses to present the result as a merge decision', () => {
    const body = formatPrRiskComment(judgment())
    expect(body).toContain(judgmentMarker('abc123'))
    expect(isPrRiskComment(body)).toBe(true)
    expect(body).toContain('記録のみ')
    expect(body).toContain('マージの可否は変えません')
    expect(body).toContain('`abc123`')
    expect(body).toContain('pr-risk-v1')
  })

  it('parses name-status and rename numstat', () => {
    const parsed = parseNameStatus('M\tsrc/app.ts\nR100\told.ts\tnew.ts\n')
    expect(parsed).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: null, deletions: null },
      { path: 'new.ts', status: 'renamed', previousPath: 'old.ts', additions: null, deletions: null },
    ])
    expect(applyNumstat(parsed, '3\t1\tsrc/app.ts\n4\t0\told.ts\tnew.ts\n')).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'new.ts', status: 'renamed', previousPath: 'old.ts', additions: 4, deletions: 0 },
    ])
  })

  it('counts a hard-rule low-risk route as a miss', () => {
    const summary = trialSummary([
      judgment(),
      judgment({
        recommendedRoute: 'additional_review',
        blockers: ['hard_rule'],
        hardRules: { matched: true, reasons: ['auth'], files: ['src/http/auth.ts'] },
      }),
      judgment({
        recommendedRoute: 'low_risk',
        blockers: [],
        hardRules: { matched: true, reasons: ['auth'], files: ['src/http/auth.ts'] },
      }),
    ])
    expect(summary).toMatchObject({
      total: 3,
      additionalReview: 1,
      lowRisk: 2,
      hardRule: 2,
      hardRuleMisses: 1,
    })
  })
})
