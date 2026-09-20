import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BAKEOFF_ARTICLES } from './bakeoff-corpus'
import type { BakeoffModelId, BakeoffRunResult } from './bakeoff-run'

/** PLaMo 円建てを速度・コスト表で並べるための換算。品質判定には使わない。 */
export const BAKEOFF_JPY_PER_USD = 150

export const BAKEOFF_ARTIFACT_DIRNAME = 'tmp/translate-bakeoff'

export function comparableUsd(result: BakeoffRunResult): number | null {
  if (typeof result.estimatedUsd === 'number') {
    return result.estimatedUsd
  }
  if (typeof result.estimatedJpy === 'number') {
    return result.estimatedJpy / BAKEOFF_JPY_PER_USD
  }
  return null
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

function formatJpy(value: number): string {
  return `¥${value.toFixed(2)}`
}

function formatMs(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`
  }
  return `${value}ms`
}

function modelIdsInOrder(results: readonly BakeoffRunResult[]): BakeoffModelId[] {
  const ids: BakeoffModelId[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if (seen.has(result.modelId)) {
      continue
    }
    seen.add(result.modelId)
    ids.push(result.modelId)
  }
  return ids
}

function byModel(results: readonly BakeoffRunResult[], modelId: BakeoffModelId): BakeoffRunResult[] {
  return results.filter((result) => result.modelId === modelId)
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function formatBakeoffSummary(results: readonly BakeoffRunResult[]): string {
  const lines: string[] = [
    '# 翻訳焼比べ（自然さ・速度・コスト）',
    '',
    '確認順: まず `ok`。`OPENAI_API_KEY is not set` / `PLAMO_API_KEY is not set` はキーがプロセスに届いていない。`.dev.vars` は焼比べランナーが読む。`HTTP 401` はキー無効。',
    '',
    '## 速度',
    '',
    '| model | ok | 平均 | 最大 | 60s超 |',
    '| --- | --- | --- | --- | --- |',
  ]

  for (const modelId of modelIdsInOrder(results)) {
    const rows = byModel(results, modelId)
    const okRows = rows.filter((row) => row.ok)
    const durations = okRows.map((row) => row.durationMs)
    const avg = mean(durations)
    const max = durations.length > 0 ? Math.max(...durations) : null
    const over = okRows.filter((row) => row.scores?.underTimeout === false).length
    lines.push(
      `| ${modelId} | ${okRows.length}/${rows.length} | ${avg === null ? '—' : formatMs(avg)} | ${max === null ? '—' : formatMs(max)} | ${over} |`,
    )
  }

  lines.push(
    '',
    '## コスト',
    '',
    `| model | 入力tok | 出力tok | 建値 | 換算USD (${BAKEOFF_JPY_PER_USD}円/$) |`,
    '| --- | --- | --- | --- | --- |',
  )

  for (const modelId of modelIdsInOrder(results)) {
    const okRows = byModel(results, modelId).filter((row) => row.ok)
    const prompt = okRows.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0)
    const completion = okRows.reduce((sum, row) => sum + (row.completionTokens ?? 0), 0)
    const usd = okRows.reduce((sum, row) => sum + (row.estimatedUsd ?? 0), 0)
    const jpy = okRows.reduce((sum, row) => sum + (row.estimatedJpy ?? 0), 0)
    const comparable = okRows.reduce((sum, row) => sum + (comparableUsd(row) ?? 0), 0)
    const native = okRows.length === 0 ? '—' : jpy > 0 ? formatJpy(jpy) : formatUsd(usd)
    const converted = okRows.length === 0 || comparable === 0 ? '—' : formatUsd(comparable)
    lines.push(
      `| ${modelId} | ${prompt === 0 ? '—' : String(prompt)} | ${completion === 0 ? '—' : String(completion)} | ${native} | ${converted} |`,
    )
  }

  lines.push(
    '',
    '## 自然さ',
    '',
    '自動では採点しない。`hedging-prose`（イディオム・ですます）を先に読み、次にコード保持の `workers-compat` を見る。本文は `tmp/translate-bakeoff/<articleId>/<modelId>.md`。',
    '',
    '| model | article | keep欠落 | 見出し | コードフェンス |',
    '| --- | --- | --- | --- | --- |',
  )

  for (const result of results) {
    if (!result.ok || result.scores === undefined) {
      const reason = result.reason ?? 'failed'
      lines.push(`| ${result.modelId} | ${result.articleId} | ${reason} | — | — |`)
      continue
    }
    const missing =
      result.scores.missingKeepTokens.length === 0 ? 'なし' : result.scores.missingKeepTokens.join(', ')
    lines.push(
      `| ${result.modelId} | ${result.articleId} | ${missing} | ${result.scores.headingCount}/${result.scores.sourceHeadingCount} | ${result.scores.codeFenceCount}/${result.scores.sourceCodeFenceCount} |`,
    )
  }

  lines.push(
    '',
    '判断: 自然さで明確に勝ち、60 秒以内、コストが許容ならそのモデル。keep token 欠落が多い候補は落す。',
    '',
  )
  return lines.join('\n')
}

function publicResult(result: BakeoffRunResult): Omit<BakeoffRunResult, 'content'> {
  return {
    articleId: result.articleId,
    modelId: result.modelId,
    ok: result.ok,
    durationMs: result.durationMs,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
    ...(result.completionTokens !== undefined ? { completionTokens: result.completionTokens } : {}),
    ...(result.estimatedUsd !== undefined ? { estimatedUsd: result.estimatedUsd } : {}),
    ...(result.estimatedJpy !== undefined ? { estimatedJpy: result.estimatedJpy } : {}),
    ...(result.scores !== undefined ? { scores: result.scores } : {}),
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(result.contentExcerpt !== undefined ? { contentExcerpt: result.contentExcerpt } : {}),
  }
}

export function writeBakeoffArtifacts(repoRoot: string, results: readonly BakeoffRunResult[]): string {
  const dir = join(repoRoot, BAKEOFF_ARTIFACT_DIRNAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.md'), formatBakeoffSummary(results), 'utf8')
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify(results.map(publicResult), null, 2)}\n`, 'utf8')

  for (const article of BAKEOFF_ARTICLES) {
    mkdirSync(join(dir, article.id), { recursive: true })
  }
  for (const result of results) {
    const path = join(dir, result.articleId, `${result.modelId}.md`)
    if (result.ok && result.content !== undefined) {
      const title = result.title ?? result.articleId
      writeFileSync(path, `# ${title}\n\n${result.content}\n`, 'utf8')
    } else {
      writeFileSync(path, `# failed: ${result.modelId} / ${result.articleId}\n\n${result.reason ?? 'unknown'}\n`, 'utf8')
    }
  }
  return dir
}
