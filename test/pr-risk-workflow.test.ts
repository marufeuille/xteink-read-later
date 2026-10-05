import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function jobBody(workflow: string, name: string): string {
  const body = workflow.split(`\n  ${name}:`)[1] ?? ''
  const next = body.search(/\n {2}[a-z0-9-]+:\n/)
  return next < 0 ? body : body.slice(0, next)
}

describe('pr-risk trial isolation', () => {
  it('does not become a required merge gate', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    const rules = readFileSync('.github/merge-gates/main-ruleset.json', 'utf8')
    const gateScript = readFileSync('.github/scripts/ci-merge-gate.sh', 'utf8')
    const workflow = readFileSync('.github/workflows/pr-risk.yml', 'utf8')
    const classify = workflow.split('\n  classify:')[1]?.split('\n  replay:')[0] ?? ''
    const replay = jobBody(workflow, 'replay')
    const review = jobBody(workflow, 'high-risk-review')
    const mergeGate = jobBody(ci, 'merge-gate')
    expect(workflow).toContain('record')
    expect(workflow).toContain('\n  workflow_dispatch:\n')
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow).not.toContain('edited')
    expect(workflow).toContain('types: [opened, synchronize, reopened, ready_for_review]')
    expect(classify).toContain("if: github.event_name == 'pull_request'")
    expect(classify).toContain('name: pr-risk-trial')
    expect(replay).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(replay).toContain('name: pr-risk-replay')
    expect(review).toContain('name: high-risk-review')
    expect(review).toContain('needs: classify')
    expect(review).toContain('secrets.OPENROUTER_API_KEY')
    expect(review).toContain('vars.HIGH_RISK_REVIEW')
    expect(review).not.toContain('pull_request_target')
    expect(review).not.toContain('continue-on-error')
    expect(mergeGate).toContain('needs: [changes, check, simulator-images]')
    expect(mergeGate).not.toContain('high-risk-review')
    expect(ci).not.toContain('pr-risk')
    expect(ci).not.toContain('high-risk-review')
    expect(rules).not.toContain('pr-risk')
    expect(rules).not.toContain('high-risk-review')
    expect(gateScript).not.toContain('high-risk-review')
  })
})
