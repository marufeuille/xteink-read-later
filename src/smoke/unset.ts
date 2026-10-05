import { appendFileSync } from 'node:fs'

/** Config and secret names only. Values, including partial values, never match. */
const CONFIG_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * Repository variable `SMOKE_REQUIRED`.
 * `true`, `1`, and `yes` are truthy. Case and surrounding whitespace are ignored.
 * Unset and every other value leave the unset skip non-failing.
 */
export function isSmokeRequired(value: string | undefined): boolean {
  if (value === undefined) {
    return false
  }
  switch (value.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
      return true
    default:
      return false
  }
}

/** Drops anything that is not a bare config name, so a value cannot be printed. */
export function listedConfigNames(missing: readonly string[]): readonly string[] {
  const names: string[] = []
  for (const name of missing) {
    if (!CONFIG_NAME.test(name) || names.includes(name)) {
      continue
    }
    names.push(name)
  }
  return names
}

function escapeWorkflowCommand(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

export type UnsetSmokeNotice = {
  readonly names: readonly string[]
  readonly annotation: string
  readonly summary: string
}

export function unsetSmokeNotice(missing: readonly string[], required: boolean): UnsetSmokeNotice {
  const names = listedConfigNames(missing)
  const listed = names.length === 0 ? '名前なし' : names.join(', ')
  const annotation = `::warning title=未設定::${escapeWorkflowCommand(`未設定: ${listed}`)}`
  const status = required
    ? '未設定のためジョブを失敗にしました。リポジトリ変数 `SMOKE_REQUIRED` が有効です。'
    : '未設定のため skip しました。'
  const lines = names.length === 0 ? '- 名前なし' : names.map((name) => `- \`${name}\``).join('\n')
  const summary = `### deploy smoke\n\n${status}\n\n${lines}\n`
  return { names, annotation, summary }
}

/**
 * Warning annotation on stdout, and the missing names in the job summary.
 * Returns 1 only when `SMOKE_REQUIRED` is truthy. The smoke outcome stays `skipped`.
 */
export function publishUnsetSkip(input: {
  readonly missing: readonly string[]
  readonly smokeRequired: string | undefined
  readonly summaryPath?: string | undefined
  readonly warn?: (line: string) => void
}): number {
  const required = isSmokeRequired(input.smokeRequired)
  const notice = unsetSmokeNotice(input.missing, required)
  const warn = input.warn ?? ((line: string) => {
    console.log(line)
  })
  warn(notice.annotation)
  const path = input.summaryPath?.trim() ?? ''
  if (path.length > 0) {
    appendFileSync(path, notice.summary)
  }
  return required ? 1 : 0
}
