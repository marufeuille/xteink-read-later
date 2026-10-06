export type SourceLocation = {
  readonly line: number
  readonly column: number
}

export type SourceRange = {
  readonly start: SourceLocation
  readonly end: SourceLocation
}

export type BranchMapping = {
  readonly type: string
  readonly loc: SourceRange
  readonly locations: readonly (SourceRange | null)[]
  readonly line?: number
}

export type FileCoverageData = {
  readonly path: string
  readonly statementMap: Readonly<Record<string, SourceRange>>
  readonly s: Readonly<Record<string, number>>
  readonly branchMap: Readonly<Record<string, BranchMapping>>
  readonly b: Readonly<Record<string, readonly number[]>>
}

export type CoverageFinal = Readonly<Record<string, FileCoverageData>>

export type CoverageMetric = {
  readonly total: number
  readonly covered: number
  readonly pct: number | null
}

export type CoverageTotals = {
  readonly lines: CoverageMetric
  readonly branches: CoverageMetric
}

export type UncoveredBranch = {
  readonly file: string
  readonly line: number
  readonly decisionLine: number
  readonly index: number
  readonly pathCount: number
  readonly type: string
}

export type DiffCoverage = {
  readonly line: CoverageMetric
  readonly branch: CoverageMetric
  readonly uncoveredLines: readonly { readonly file: string; readonly start: number; readonly end: number }[]
  readonly uncoveredBranches: readonly UncoveredBranch[]
  readonly missingFiles: readonly { readonly file: string; readonly start: number; readonly end: number }[]
}

const DEFAULT_MAX_LISTED = 500

export function isWorkerSource(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  return normalized.startsWith('src/') && normalized.endsWith('.ts') && !normalized.endsWith('.d.ts')
}

export function istanbulPercent(covered: number, total: number): number | null {
  if (total <= 0) return null
  return Math.floor((1e5 * covered) / total / 10) / 100
}

export function parseUnifiedDiff(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>()
  let path: string | null = null
  let newLine = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = null
      inHunk = false
      continue
    }
    // A source line that starts with "++ " is an added line "+++ …" inside a hunk.
    // Only a +++ header before the hunk names the new file.
    if (!inHunk && line.startsWith('+++ ')) {
      path = workerPath(parseDiffPath(line.slice(4)))
      inHunk = false
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk?.[1]) {
      newLine = Number(hunk[1])
      inHunk = path !== null
      continue
    }
    if (!inHunk || path === null) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      const lines = changed.get(path) ?? new Set<number>()
      lines.add(newLine)
      changed.set(path, lines)
      newLine += 1
      continue
    }
    if (line.startsWith('-')) continue
    if (line.startsWith(' ')) newLine += 1
  }
  return changed
}

export function lineHits(file: FileCoverageData): Map<number, number> {
  const hits = new Map<number, number>()
  for (const [id, count] of Object.entries(file.s)) {
    const statement = file.statementMap[id]
    if (!statement || !Number.isFinite(count)) continue
    const line = statement.start.line
    const previous = hits.get(line)
    if (previous === undefined || previous < count) hits.set(line, count)
  }
  return hits
}

export function diffCoverage(input: {
  readonly changedLines: ReadonlyMap<string, ReadonlySet<number>>
  readonly coverage: CoverageFinal
  readonly root: string
}): DiffCoverage {
  const byPath = indexCoverage(input.coverage, input.root)
  const uncoveredLineRanges: { file: string; start: number; end: number }[] = []
  const uncoveredBranches: UncoveredBranch[] = []
  const missingRanges: { file: string; start: number; end: number }[] = []
  let lineTotal = 0
  let lineCovered = 0
  let branchTotal = 0
  let branchCovered = 0

  const files = [...input.changedLines.keys()].filter(isWorkerSource).sort((a, b) => a.localeCompare(b))
  for (const file of files) {
    const changed = input.changedLines.get(file)
    if (!changed || changed.size === 0) continue
    const data = byPath.get(file)
    if (!data) {
      missingRanges.push(...rangesFor(file, [...changed]))
      continue
    }
    const hits = lineHits(data)
    const uncovered: number[] = []
    for (const line of [...changed].sort((a, b) => a - b)) {
      const count = hits.get(line)
      if (count === undefined) continue
      lineTotal += 1
      if (count > 0) lineCovered += 1
      else uncovered.push(line)
    }
    uncoveredLineRanges.push(...rangesFor(file, uncovered))
    for (const branch of branchesInChange(file, data, changed)) {
      branchTotal += 1
      if (branch.covered) branchCovered += 1
      else uncoveredBranches.push(branch.item)
    }
  }
  uncoveredBranches.sort(compareBranches)
  return {
    line: metric(lineCovered, lineTotal),
    branch: metric(branchCovered, branchTotal),
    uncoveredLines: uncoveredLineRanges,
    uncoveredBranches,
    missingFiles: missingRanges,
  }
}

export function parseCoverageFinal(value: unknown): CoverageFinal {
  if (!isRecord(value)) throw new Error('coverage-final.json がオブジェクトではありません')
  const files: Record<string, FileCoverageData> = {}
  for (const [key, entry] of Object.entries(value)) {
    const file = parseFileCoverage(entry, key)
    if (file) files[file.path.length > 0 ? file.path : key] = file
  }
  return files
}

export function parseCoverageTotals(value: unknown): CoverageTotals | null {
  if (!isRecord(value)) return null
  const total = value['total']
  if (!isRecord(total)) return null
  const lines = parseMetric(total['lines'])
  const branches = parseMetric(total['branches'])
  if (!lines || !branches) return null
  return { lines, branches }
}

export function renderDiffCoverageReport(input: {
  readonly diff: DiffCoverage
  readonly totals: CoverageTotals | null
  readonly elapsedSeconds: number | null
  readonly vitestStatus: number | null
  readonly diffMode: 'three-dot' | 'two-dot' | 'none'
  readonly notes: readonly string[]
  readonly maxListed?: number
}): string {
  const maxListed = input.maxListed ?? DEFAULT_MAX_LISTED
  const lines: string[] = [
    '### 差分カバレッジ（unit）',
    '',
    '表示のみ。閾値では失敗させない。対象は `src/**/*.ts`（`.d.ts` を除く）の追加・変更行。行は文の開始行。分岐は、その行か条件の行が変更に含まれる未実行の分岐。',
    '',
    '| | 行 | 分岐 |',
    '| --- | ---: | ---: |',
    `| 変更箇所 | ${formatMetric(input.diff.line)} | ${formatMetric(input.diff.branch)} |`,
    `| 全体 | ${input.totals ? formatMetric(input.totals.lines) : '計測なし'} | ${input.totals ? formatMetric(input.totals.branches) : '計測なし'} |`,
    '',
    `比較: ${diffModeLabel(input.diffMode)}`,
    '',
    '#### 未検証の行',
    '',
    ...listOrNone(input.diff.uncoveredLines.map(formatRange), '未検証の行はありません。', maxListed),
    '',
    '#### 未検証の分岐',
    '',
    ...listOrNone(input.diff.uncoveredBranches.map(formatBranch), '未検証の分岐はありません。', maxListed),
  ]
  if (input.diff.missingFiles.length > 0) {
    lines.push('', '#### カバレッジデータがない変更ファイル', '')
    lines.push(...listOrNone(input.diff.missingFiles.map(formatRange), '', maxListed))
  }
  if (input.notes.length > 0) {
    lines.push('', '#### 取得メモ', '')
    for (const note of input.notes) lines.push(`- ${note}`)
  }
  lines.push('')
  if (input.elapsedSeconds !== null) lines.push(`coverage_elapsed_seconds=${input.elapsedSeconds}`)
  if (input.vitestStatus !== null) lines.push(`vitest_exit_status=${input.vitestStatus}`)
  lines.push('')
  return lines.join('\n')
}

export function formatMetric(metric: CoverageMetric): string {
  if (metric.total <= 0 || metric.pct === null) return `${metric.covered}/${metric.total}`
  return `${metric.covered}/${metric.total} (${formatPct(metric.pct)}%)`
}

export function lineRanges(lines: readonly number[]): readonly { readonly start: number; readonly end: number }[] {
  const sorted = [...new Set(lines)].filter((line) => line > 0).sort((a, b) => a - b)
  const ranges: { start: number; end: number }[] = []
  for (const line of sorted) {
    const last = ranges.at(-1)
    if (last && line === last.end + 1) last.end = line
    else ranges.push({ start: line, end: line })
  }
  return ranges
}

function metric(covered: number, total: number): CoverageMetric {
  return { covered, total, pct: istanbulPercent(covered, total) }
}

function formatPct(pct: number): string {
  return pct.toFixed(2).replace(/\.?0+$/, '')
}

function diffModeLabel(mode: 'three-dot' | 'two-dot' | 'none'): string {
  if (mode === 'three-dot') return 'pull request の three-dot'
  if (mode === 'two-dot') return 'two-dot'
  return '比較なし'
}

function formatRange(range: { readonly file: string; readonly start: number; readonly end: number }): string {
  const lines = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`
  return `- \`${range.file}:${lines}\``
}

function formatBranch(branch: UncoveredBranch): string {
  const at = `\`${branch.file}:${branch.line}\``
  const condition = branch.line === branch.decisionLine ? at : `${at}（条件 \`${branch.file}:${branch.decisionLine}\`）`
  const kind = branch.type.length > 0 ? `（${branch.type}）` : ''
  return `- ${condition} 分岐 ${branch.index}/${branch.pathCount}${kind}`
}

function listOrNone(items: readonly string[], empty: string, maxListed: number): string[] {
  if (items.length === 0) return empty.length > 0 ? [empty] : []
  const shown = items.slice(0, maxListed)
  if (items.length > shown.length) {
    shown.push(`- ほか ${items.length - shown.length} 件`)
  }
  return shown
}

function rangesFor(file: string, lines: readonly number[]): { file: string; start: number; end: number }[] {
  return lineRanges(lines).map((range) => ({ file, start: range.start, end: range.end }))
}

function compareBranches(a: UncoveredBranch, b: UncoveredBranch): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.index - b.index
}

function branchesInChange(
  file: string,
  data: FileCoverageData,
  changed: ReadonlySet<number>,
): readonly { readonly covered: boolean; readonly item: UncoveredBranch }[] {
  const found: { covered: boolean; item: UncoveredBranch }[] = []
  for (const [id, branch] of Object.entries(data.branchMap)) {
    const counts = data.b[id] ?? []
    const decisionLine = branch.line ?? branch.loc.start.line
    const pathCount = counts.length
    for (let index = 0; index < pathCount; index += 1) {
      const location = branch.locations[index]
      const line = location?.start.line ?? decisionLine
      if (line <= 0 || (!changed.has(line) && !changed.has(decisionLine))) continue
      const count = counts[index] ?? 0
      found.push({
        covered: count > 0,
        item: {
          file,
          line,
          decisionLine,
          index: index + 1,
          pathCount,
          type: branch.type,
        },
      })
    }
  }
  return found
}

function indexCoverage(coverage: CoverageFinal, root: string): Map<string, FileCoverageData> {
  const indexed = new Map<string, FileCoverageData>()
  for (const [key, file] of Object.entries(coverage)) {
    const relative = toRepoPath(file.path || key, root)
    if (!isWorkerSource(relative)) continue
    indexed.set(relative, file)
  }
  return indexed
}

export function toRepoPath(filePath: string, root: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const withoutFileUrl = normalized.startsWith('file://') ? decodeURIComponent(normalized.slice('file://'.length)) : normalized
  const rootNorm = root.replaceAll('\\', '/').replace(/\/$/, '')
  const relative = withoutFileUrl.startsWith(`${rootNorm}/`) ? withoutFileUrl.slice(rootNorm.length + 1) : withoutFileUrl
  return relative.replace(/^\.\//, '')
}

function workerPath(path: string | null): string | null {
  if (path === null || !isWorkerSource(path)) return null
  return path
}

function parseDiffPath(raw: string): string | null {
  const token = raw.trim().split('\t')[0] ?? ''
  if (token.length === 0) return null
  const path = token.startsWith('"') ? unescapeGitPath(token) : token
  if (path === '/dev/null') return null
  if (path.startsWith('b/') || path.startsWith('a/')) return path.slice(2)
  return path
}

const GIT_C_ESCAPES: Readonly<Record<string, number>> = {
  '\\': 0x5c,
  '"': 0x22,
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  a: 0x07,
  b: 0x08,
  v: 0x0b,
  f: 0x0c,
}

function unescapeGitPath(quoted: string): string {
  const body = quoted.endsWith('"') ? quoted.slice(1, -1) : quoted.slice(1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const current = body[i] ?? ''
    if (current !== '\\') {
      bytes.push(current.charCodeAt(0))
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      bytes.push(0x5c)
      break
    }
    const simple = GIT_C_ESCAPES[next]
    if (simple !== undefined) {
      bytes.push(simple)
      i += 1
      continue
    }
    if (next >= '0' && next <= '7') {
      let octal = ''
      for (let j = 1; j <= 3 && i + j < body.length; j += 1) {
        const digit = body[i + j] ?? ''
        if (digit < '0' || digit > '7') break
        octal += digit
      }
      bytes.push(Number.parseInt(octal, 8))
      i += octal.length
      continue
    }
    bytes.push(next.charCodeAt(0))
    i += 1
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

function parseFileCoverage(value: unknown, fallbackPath: string): FileCoverageData | null {
  if (!isRecord(value)) return null
  const pathValue = value['path']
  const path = typeof pathValue === 'string' && pathValue.length > 0 ? pathValue : fallbackPath
  const statementMap = parseStatementMap(value['statementMap'])
  const hits = parseHitMap(value['s'])
  const branchMap = parseBranchMap(value['branchMap'])
  const branches = parseBranchHits(value['b'])
  if (!statementMap || !hits || !branchMap || !branches) return null
  return { path, statementMap, s: hits, branchMap, b: branches }
}

function parseStatementMap(value: unknown): FileCoverageData['statementMap'] | null {
  if (!isRecord(value)) return null
  const map: Record<string, SourceRange> = {}
  for (const [id, range] of Object.entries(value)) {
    const parsed = parseRange(range)
    if (parsed) map[id] = parsed
  }
  return map
}

function parseHitMap(value: unknown): FileCoverageData['s'] | null {
  if (!isRecord(value)) return null
  const hits: Record<string, number> = {}
  for (const [id, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isFinite(count)) hits[id] = count
  }
  return hits
}

function parseBranchMap(value: unknown): FileCoverageData['branchMap'] | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const map: Record<string, BranchMapping> = {}
  for (const [id, branch] of Object.entries(value)) {
    const parsed = parseBranch(branch)
    if (parsed) map[id] = parsed
  }
  return map
}

function parseBranchHits(value: unknown): FileCoverageData['b'] | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const hits: Record<string, number[]> = {}
  for (const [id, counts] of Object.entries(value)) {
    if (!Array.isArray(counts)) continue
    const numbers = counts.filter((count): count is number => typeof count === 'number' && Number.isFinite(count))
    if (numbers.length === counts.length) hits[id] = numbers
  }
  return hits
}

function parseBranch(value: unknown): BranchMapping | null {
  if (!isRecord(value)) return null
  const loc = parseRange(value['loc'])
  if (!loc) return null
  const locationsValue = value['locations']
  const locations = Array.isArray(locationsValue) ? locationsValue.map((location) => parseRange(location)) : []
  const type = typeof value['type'] === 'string' ? value['type'] : ''
  const line = typeof value['line'] === 'number' && value['line'] > 0 ? value['line'] : undefined
  return line === undefined ? { type, loc, locations } : { type, loc, locations, line }
}

function parseRange(value: unknown): SourceRange | null {
  if (!isRecord(value)) return null
  const start = parseLocation(value['start'])
  const end = parseLocation(value['end'])
  if (!start || !end) return null
  return { start, end }
}

function parseLocation(value: unknown): SourceLocation | null {
  if (!isRecord(value)) return null
  const line = value['line']
  if (typeof line !== 'number' || line <= 0) return null
  const column = value['column']
  return { line, column: typeof column === 'number' ? column : 0 }
}

function parseMetric(value: unknown): CoverageMetric | null {
  if (!isRecord(value)) return null
  const total = value['total']
  const covered = value['covered']
  if (typeof total !== 'number' || typeof covered !== 'number') return null
  const pctValue = value['pct']
  const pct = typeof pctValue === 'number' && Number.isFinite(pctValue) ? pctValue : null
  return { total, covered, pct }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
