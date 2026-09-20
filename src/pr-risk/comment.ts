import type { PrRiskJudgment, PrRiskRoute } from '../types/index.ts'
import { PR_RISK_COMMENT_MARKER, PR_RISK_RULE_VERSION } from './constants.ts'

const ROUTE_LABEL: Readonly<Record<PrRiskRoute, string>> = {
  additional_review: '追加レビュー',
  low_risk: '低リスク候補',
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

function quoted(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.map((item) => `\`${item}\``).join(', ')
}

function formatJev(judgment: PrRiskJudgment): string {
  const jev = judgment.jev
  if (jev === null) {
    const skipped = judgment.blockers.includes('jev_skipped') ? '未実施（キーなし）' : '失敗'
    const detail = judgment.jevError === null ? skipped : `${skipped}: ${judgment.jevError.code}`
    return `- Jev: ${detail}`
  }
  const probabilities = Object.entries(jev.changeRisk.probabilities)
    .map(([key, probability]) => `${key}=${pct(probability)}`)
    .join(', ')
  const noulLines = (
    [
      ['touches_auth', jev.touchesAuth],
      ['touches_secrets', jev.touchesSecrets],
      ['touches_data_lifecycle', jev.touchesDataLifecycle],
      ['touches_ci_deploy_rules', jev.touchesCiDeployRules],
    ] as const
  ).map(([key, value]) => `- ${key}: ${pct(value)}`)
  return [
    `- モデル: \`${jev.model}\`（${jev.durationMs}ms, inputTokens=${jev.inputTokens ?? '不明'}）`,
    `- change_risk: \`${jev.changeRisk.choice}\` / 信頼度 ${pct(jev.changeRisk.confidence)} / { ${probabilities} }`,
    ...noulLines,
  ].join('\n')
}

export function judgmentMarker(headSha: string): string {
  return `${PR_RISK_COMMENT_MARKER} sha=${headSha} rule=${PR_RISK_RULE_VERSION} -->`
}

export function isPrRiskComment(body: string): boolean {
  return body.includes(PR_RISK_COMMENT_MARKER)
}

export function formatPrRiskComment(judgment: PrRiskJudgment): string {
  const files = quoted(judgment.input.files, '(なし)')
  const blockers = quoted(judgment.blockers, '(なし)')
  const hard = judgment.hardRules.matched ? quoted(judgment.hardRules.reasons, '') : 'なし'
  return `${judgmentMarker(judgment.headSha)}
## PR リスク判定（試行）

このコメントは **記録のみ** です。マージの可否は変えません。Jev の型保証は精度の保証ではなく、単独ではマージ権限を与えません。

| 項目 | 値 |
| --- | --- |
| head SHA | \`${judgment.headSha}\` |
| base SHA | \`${judgment.baseSha}\` |
| ルール | \`${judgment.ruleVersion}\` |
| 推奨ルート | ${ROUTE_LABEL[judgment.recommendedRoute]} |
| 試行アクション | \`record_only\` |
| 入力 | ファイル ${judgment.input.fileCount} / diff ${judgment.input.diffChars} 字 / truncated=${judgment.input.truncated} / missingDiff=${judgment.input.missingDiff} |
| Linear | ${quoted(judgment.input.linearIds, 'なし')} |
| 固定ルール | ${hard} |
| blockers | ${blockers} |

${formatJev(judgment)}

変更ファイル: ${files}
`
}

export function judgmentJson(judgment: PrRiskJudgment): string {
  return `${JSON.stringify(judgment, null, 2)}\n`
}
