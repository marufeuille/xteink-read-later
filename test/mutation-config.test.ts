import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { patchStrykerTestNameJoin } from '../scripts/prepare-stryker-vitest.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('mutation testing', () => {
  it('runs Stryker on auth files by hand and stays out of pull request CI', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts['test:mutation']).toBe(
      'node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/prepare-stryker-vitest.ts && stryker run',
    )
    expect(pkg.scripts['test']).not.toContain('mutation')
    expect(pkg.scripts['test:unit']).toBe('vitest run')
    expect(pkg.devDependencies['@stryker-mutator/core']).toBe('10.0.0')
    expect(pkg.devDependencies['@stryker-mutator/vitest-runner']).toBe('10.0.0')

    const config = JSON.parse(readFileSync(join(root, 'stryker.config.json'), 'utf8')) as {
      testRunner: string
      plugins: string[]
      mutate: string[]
      reporters: string[]
      thresholds: { break: number | null }
      coverageAnalysis: string
      ignorePatterns: string[]
    }
    expect(config.testRunner).toBe('vitest')
    expect(config.plugins).toEqual(['@stryker-mutator/vitest-runner'])
    expect(config.coverageAnalysis).toBe('perTest')
    expect(config.reporters).toEqual(['clear-text', 'json', 'progress'])
    expect(config.thresholds.break).toBeNull()
    expect(config.ignorePatterns).toEqual(['/coverage', '/dist', '/.wrangler', '/simulator/out'])
    const spaceJoin = "return nameParts.join(' ').trim();"
    const vitestJoin = "return nameParts.join(' > ').trim();"
    expect(patchStrykerTestNameJoin(spaceJoin, 'fixture.js')).toBe(vitestJoin)
    expect(patchStrykerTestNameJoin(vitestJoin, 'fixture.js')).toBe(vitestJoin)
    expect(() => patchStrykerTestNameJoin('no join here', 'fixture.js')).toThrow(/fixture\.js/)
    expect(config.mutate).toEqual([
      'src/http/auth.ts',
      'src/http/access-identity.ts',
      'src/http/candidate-session.ts',
      'src/http/clip-web-auth.ts',
      'src/digest/confirm-link.ts',
    ])

    const workflow = readFileSync(join(root, '.github/workflows/mutation.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('pull_request:')
    expect(workflow).not.toContain('\n  push:\n')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).toContain('npm run test:mutation')
    expect(workflow).not.toContain('dashboard')

    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).not.toContain('test:mutation')
    expect(ci).not.toContain('stryker')
  })
})
