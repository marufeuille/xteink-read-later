import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
const ruleset = JSON.parse(
  readFileSync(join(root, '.github/merge-gates/main-ruleset.json'), 'utf8'),
) as {
  name: string
  enforcement: string
  bypass_actors: unknown[]
  conditions: { ref_name: { include: string[] } }
  rules: { type: string; parameters?: Record<string, unknown> }[]
}

describe('GitHub merge gates', () => {
  it('runs CI on pull requests and merge groups without skipping the gate', () => {
    expect(workflow).toContain('\n  pull_request:\n')
    expect(workflow).toContain('\n  merge_group:\n')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toMatch(/continue-on-error:\s*true/)
    expect(workflow).toContain('name: typecheck, unit, e2e')
    expect(workflow).toContain('npm run typecheck')
    expect(workflow).toContain('npm run test:unit')
    expect(workflow).toContain('npm run test:e2e')
  })

  it('fails merge-gate unless typecheck, unit, e2e succeeded', () => {
    const mergeGate = workflow.split('\n  merge-gate:')[1]?.split('\n  deploy:')[0] ?? ''
    expect(mergeGate).toContain('name: merge-gate')
    expect(mergeGate).toContain('if: always()')
    expect(mergeGate).toContain('needs: check')
    expect(mergeGate).toContain('needs.check.result')
    expect(mergeGate).toContain('test "$result" = success')
    expect(workflow).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    )
  })

  it('pins the required check to GitHub Actions with an empty bypass list', () => {
    expect(ruleset.name).toBe('main-merge-gates')
    expect(ruleset.enforcement).toBe('active')
    expect(ruleset.bypass_actors).toEqual([])
    expect(ruleset.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH'])
    expect(ruleset.rules.map((rule) => rule.type)).toEqual([
      'deletion',
      'non_fast_forward',
      'pull_request',
      'required_status_checks',
      'merge_queue',
    ])
    const pull = ruleset.rules.find((rule) => rule.type === 'pull_request')
    expect(pull?.parameters?.required_approving_review_count).toBe(0)
    expect(pull?.parameters?.required_review_thread_resolution).toBe(true)
    expect(pull?.parameters?.require_last_push_approval).toBe(false)
    const checks = ruleset.rules.find((rule) => rule.type === 'required_status_checks')
    expect(checks?.parameters?.strict_required_status_checks_policy).toBe(false)
    expect(checks?.parameters?.required_status_checks).toEqual([
      { context: 'merge-gate', integration_id: 15368 },
    ])
    const queue = ruleset.rules.find((rule) => rule.type === 'merge_queue')
    expect(queue?.parameters?.grouping_strategy).toBe('ALLGREEN')
  })

  it('parses apply and verify scripts', () => {
    for (const script of ['apply-merge-gates.sh', 'verify-merge-gates.sh']) {
      execFileSync('bash', ['-n', join(root, '.github/scripts', script)])
    }
  })

  it('intentionally fails to verify merge-gate', () => {
    expect(false).toBe(true)
  })
})
