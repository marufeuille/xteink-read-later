import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('pr-risk trial isolation', () => {
  it('does not become a required merge gate', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    const rules = readFileSync('.github/merge-gates/main-ruleset.json', 'utf8')
    const workflow = readFileSync('.github/workflows/pr-risk.yml', 'utf8')
    expect(workflow).toContain('name: pr-risk-trial')
    expect(workflow).toContain('record')
    expect(ci).not.toContain('pr-risk')
    expect(rules).not.toContain('pr-risk')
  })
})
