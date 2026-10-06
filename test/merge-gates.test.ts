import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function jobBody(workflow: string, name: string): string {
  const body = workflow.split(`\n  ${name}:`)[1] ?? ''
  const next = body.search(/\n {2}[a-z0-9-]+:\n/)
  return next < 0 ? body : body.slice(0, next)
}

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
    const header = workflow.split('\njobs:')[0] ?? ''
    expect(header).not.toMatch(/\n\s+paths:/)
    expect(header).not.toMatch(/\n\s+paths-ignore:/)
    expect(workflow.match(/continue-on-error:\s*true/g)).toEqual(['continue-on-error: true'])
    for (const name of ['changes', 'check', 'simulator-images', 'merge-gate', 'deploy', 'deploy-smoke', 'deploy-rollback']) {
      expect(jobBody(workflow, name), name).not.toMatch(/continue-on-error/)
    }
    expect(jobBody(workflow, 'diff-coverage')).toContain('continue-on-error: true')
    expect(workflow).toContain('name: typecheck, unit, e2e')
    expect(workflow).toContain('npm run typecheck')
    expect(workflow).toContain('npm run test:unit')
    expect(workflow).toContain('npm run test:e2e')
  })

  it('runs check and simulator from the path filter and accepts a path skip at merge-gate', () => {
    const changes = workflow.split('\n  changes:')[1]?.split('\n  check:')[0] ?? ''
    expect(changes).toContain('name: classify changes')
    expect(changes).toContain('fetch-depth: 0')
    expect(changes).toContain('bash .github/scripts/ci-changed-paths.sh github')
    expect(changes).toContain('check: ${{ steps.filter.outputs.check }}')
    expect(changes).toContain('simulator: ${{ steps.filter.outputs.simulator }}')
    expect(changes).toContain('deploy: ${{ steps.filter.outputs.deploy }}')

    const check = workflow.split('\n  check:')[1]?.split('\n  simulator-images:')[0] ?? ''
    expect(check).toContain('name: typecheck, unit, e2e')
    expect(check).toContain('needs: changes')
    expect(check).toContain("if: ${{ needs.changes.outputs.check == 'true' }}")
    expect(check).toContain('timeout-minutes: 10')
    expect(check).toContain('npm run typecheck')
    expect(check).toContain('npm run test:unit')
    expect(check).toContain('npm run test:e2e')
    expect(check).not.toContain('simulator:images')

    const simulator = workflow.split('\n  simulator-images:')[1]?.split('\n  merge-gate:')[0] ?? ''
    expect(simulator).toContain('name: simulator images')
    expect(simulator).toContain('needs: changes')
    expect(simulator).toContain("if: ${{ needs.changes.outputs.simulator == 'true' }}")
    expect(simulator).toContain('timeout-minutes: 45')
    expect(simulator).toContain('libsdl2-dev')
    expect(simulator).toContain('libssl-dev')
    expect(simulator).toContain('xvfb')
    expect(simulator).toContain('platformio==6.1.19')
    expect(simulator).toContain('npm run simulator:images')
    expect(simulator).toContain('name: Upload simulator screenshots')
    expect(simulator).toContain('path: simulator/out')
    const withoutFilter = simulator.replace(
      "if: ${{ needs.changes.outputs.simulator == 'true' }}\n",
      '',
    )
    const withoutFailedUpload = withoutFilter.replace('\n        if: failure()\n', '\n')
    expect(withoutFailedUpload).not.toMatch(/\n\s*if:/)

    const mergeGate = workflow.split('\n  merge-gate:')[1]?.split('\n  deploy:')[0] ?? ''
    expect(mergeGate).toContain('name: merge-gate')
    expect(mergeGate).toContain('if: always()')
    expect(mergeGate).toContain('needs: [changes, check, simulator-images]')
    expect(mergeGate).toContain('CHANGES_RESULT: ${{ needs.changes.result }}')
    expect(mergeGate).toContain('CHECK_RESULT: ${{ needs.check.result }}')
    expect(mergeGate).toContain('SIMULATOR_RESULT: ${{ needs.simulator-images.result }}')
    expect(mergeGate).toContain('bash .github/scripts/ci-merge-gate.sh')
    expect(mergeGate).not.toContain('test "$check" = success')
    expect(mergeGate).not.toContain('test "$simulator" = success')

    const deploy = workflow.split('\n  deploy:')[1] ?? ''
    expect(deploy).toContain('needs: [changes, check, simulator-images]')
    expect(deploy).toContain("github.event_name == 'push'")
    expect(deploy).toContain("github.ref == 'refs/heads/main'")
    expect(deploy).toContain("needs.changes.result == 'success'")
    expect(deploy).toContain("needs.changes.outputs.deploy == 'true'")
    expect(deploy).toContain("needs.check.result == 'success'")
    expect(deploy).toContain("needs.simulator-images.result == 'success'")
    expect(deploy).toContain("needs.simulator-images.result == 'skipped'")
    expect(deploy).not.toContain('success()')
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
    for (const script of [
      'apply-merge-gates.sh',
      'verify-merge-gates.sh',
      'ci-changed-paths.sh',
      'ci-merge-gate.sh',
      'ci-diff-coverage.sh',
    ]) {
      execFileSync('bash', ['-n', join(root, '.github/scripts', script)])
    }
  })
})
