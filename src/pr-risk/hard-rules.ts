import type { HardRuleMatch, HardRuleReason, PrChangedFile } from '../types'

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function isAuthPath(path: string): boolean {
  return path === 'src/http/auth.ts' || path === 'test/auth.test.ts'
}

function isSecretsPath(path: string): boolean {
  const base = path.split('/').at(-1) ?? path
  return (
    base === '.dev.vars' ||
    base.startsWith('.dev.vars.') ||
    base === '.env' ||
    base.startsWith('.env.') ||
    /^secrets?\./i.test(base) ||
    /credentials?\./i.test(base)
  )
}

function isCiDeployPath(path: string): boolean {
  return (
    path.startsWith('.github/') ||
    path === 'wrangler.jsonc' ||
    path === 'wrangler.json' ||
    path === 'wrangler.toml'
  )
}

function isJudgmentRulePath(path: string): boolean {
  return (
    path === 'AGENTS.md' ||
    path === 'docs/pr-risk.md' ||
    path === 'docs/github-merge-gates.md' ||
    path.startsWith('src/pr-risk/') ||
    path === 'src/types/pr-risk.ts' ||
    /^test\/pr-risk.*\.test\.ts$/.test(path)
  )
}

function isDataLifecyclePath(path: string): boolean {
  return /migrat/i.test(path) || /(^|\/)migrations?\//i.test(path)
}

const PATH_RULES: readonly { readonly reason: HardRuleReason; readonly match: (path: string) => boolean }[] = [
  { reason: 'auth', match: isAuthPath },
  { reason: 'secrets', match: isSecretsPath },
  { reason: 'ci_deploy', match: isCiDeployPath },
  { reason: 'judgment_rules', match: isJudgmentRulePath },
  { reason: 'data_lifecycle', match: isDataLifecyclePath },
]

function reasonsFor(path: string): readonly HardRuleReason[] {
  return PATH_RULES.filter((rule) => rule.match(path)).map((rule) => rule.reason)
}

function pathsOf(file: PrChangedFile): readonly string[] {
  const path = normalizePath(file.path)
  const previous = file.previousPath
  return previous === undefined || previous.length === 0 ? [path] : [path, normalizePath(previous)]
}

export function matchHardRules(files: readonly PrChangedFile[]): HardRuleMatch {
  const matched = files.flatMap((file) =>
    pathsOf(file).flatMap((path) => {
      const reasons = reasonsFor(path)
      return reasons.length === 0 ? [] : [{ path, reasons }]
    }),
  )
  return {
    matched: matched.length > 0,
    reasons: [...new Set(matched.flatMap((entry) => entry.reasons))],
    files: matched.map((entry) => entry.path),
  }
}

export function isTestFile(path: string): boolean {
  const normalized = normalizePath(path)
  return /(^|\/)test\//.test(normalized) || /\.test\.[cm]?[jt]sx?$/.test(normalized)
}
