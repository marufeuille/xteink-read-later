import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('pr-risk trial isolation', () => {
  it('does not become a required merge gate', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    const rules = readFileSync('.github/merge-gates/main-ruleset.json', 'utf8')
    const workflow = readFileSync('.github/workflows/pr-risk.yml', 'utf8')
    const classify = workflow.split('\n  classify:')[1]?.split('\n  replay:')[0] ?? ''
    const replay = workflow.split('\n  replay:')[1] ?? ''
    expect(workflow).toContain('record')
    expect(workflow).toContain('\n  workflow_dispatch:\n')
    expect(classify).toContain("if: github.event_name == 'pull_request'")
    expect(classify).toContain('name: pr-risk-trial')
    expect(replay).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(replay).toContain('name: pr-risk-replay')
    expect(ci).not.toContain('pr-risk')
    expect(rules).not.toContain('pr-risk')
  })
})
