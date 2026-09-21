import { describe, expect, it } from 'vitest'
import { isTestFile, matchHardRules } from '../src/pr-risk/hard-rules'
import type { PrChangedFile } from '../src/types'

function file(path: string): PrChangedFile {
  return { path, status: 'modified', additions: 1, deletions: 0 }
}

describe('matchHardRules', () => {
  it('flags auth, secrets, CI/deploy, judgment rules, and migrations', () => {
    expect(matchHardRules([file('src/http/auth.ts')])).toMatchObject({
      matched: true,
      reasons: ['auth'],
      files: ['src/http/auth.ts'],
    })
    expect(matchHardRules([file('src/http/clip-web-auth.ts')]).reasons).toEqual(['auth'])
    expect(matchHardRules([file('src/http/access-identity.ts')]).reasons).toEqual(['auth'])
    expect(matchHardRules([file('src/http/candidate-session.ts')]).reasons).toEqual(['auth'])
    expect(matchHardRules([file('.dev.vars.example')]).reasons).toEqual(['secrets'])
    expect(matchHardRules([file('.dev.vars.local')]).reasons).toEqual(['secrets'])
    expect(
      matchHardRules([
        { path: 'src/http/session.ts', previousPath: 'src/http/auth.ts', status: 'renamed', additions: 0, deletions: 0 },
      ]).reasons,
    ).toEqual(['auth'])
    expect(matchHardRules([file('.github/workflows/ci.yml')]).reasons).toEqual(['ci_deploy'])
    expect(matchHardRules([file('wrangler.jsonc')]).reasons).toEqual(['ci_deploy'])
    expect(matchHardRules([file('AGENTS.md')]).reasons).toEqual(['judgment_rules'])
    expect(matchHardRules([file('src/pr-risk/classify.ts')]).reasons).toEqual(['judgment_rules'])
    expect(matchHardRules([file('docs/pr-risk.md')]).reasons).toEqual(['judgment_rules'])
    expect(matchHardRules([file('src/store/migrations/001.sql')]).reasons).toEqual(['data_lifecycle'])
  })

  it('does not flag ordinary app or docs changes', () => {
    expect(matchHardRules([file('src/extract/pipeline.ts'), file('README.md'), file('test/epub.test.ts')])).toEqual({
      matched: false,
      reasons: [],
      files: [],
    })
  })

  it('keeps every matching file and reason', () => {
    const result = matchHardRules([file('src/http/auth.ts'), file('.github/workflows/ci.yml')])
    expect(result.matched).toBe(true)
    expect(result.reasons).toEqual(['auth', 'ci_deploy'])
    expect(result.files).toEqual(['src/http/auth.ts', '.github/workflows/ci.yml'])
  })

  it('treats test/ paths as tests', () => {
    expect(isTestFile('test/pr-risk-classify.test.ts')).toBe(true)
    expect(isTestFile('src/pr-risk/classify.ts')).toBe(false)
  })
})
