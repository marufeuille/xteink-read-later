# 単体テストのカバレッジ（MAR-63）

unit の既存ランナー Vitest（`vitest run`）に、同じ Vitest の v8 カバレッジを足して行と分岐を測る。新しいテストランナーは入れていない。E2E と simulator は測らない。閾値は無い。Codecov などの外部サービスも、追加の secret も使わない。

PR で Worker のコード（`src/**/*.ts`）が変わると、`diff coverage` ジョブの summary に、変更行のうち未実行の行と分岐をファイルと行番号で出す。docs だけの差分では、`check` と同じパス分類でこのジョブは skipped になる。取得や表示が失敗しても `merge-gate` は落とさない。判定の詳細は [github-merge-gates.md](github-merge-gates.md)。

## 測り方

| 項目 | 内容 |
| --- | --- |
| コマンド | `npm run test:unit:coverage`（`vitest run --coverage`） |
| provider | `@vitest/coverage-v8` `5.0.1`（Vitest `5.0.1` に合わせた devDependency） |
| 対象 | `src/**/*.ts`（`.d.ts` を除く）。テストが import していないファイルも含む |
| 行 | Istanbul の行カバレッジ。文の開始行で、ヒットの最大が 0 の行が未検証 |
| 分岐 | ヒット 0 の分岐。差分では、その行か条件の行が変更に含まれるもの |
| 変更行 | `pull_request` は base との three-dot。`merge_group` と `push` は two-dot。削除行は含めない |
| 通常の unit | `npm run test:unit` はカバレッジなしのまま。成否は `typecheck, unit, e2e` が見る |

全体の行・分岐は Vitest が書く `coverage-summary.json` の `total.lines` と `total.branches`。差分の行・分岐は上の定義で、変更された実行行と変更に含まれる分岐だけを数える。

## いまの全体

1回測った。commit `320683c18005871c04201a1d923457f50a5d3e89`、workflow run [37397456092](https://github.com/marufeuille/xteink-read-later/actions/runs/37397456092) の `diff coverage` ジョブ（[112056750185](https://github.com/marufeuille/xteink-read-later/actions/runs/37397456092/job/112056750185)）。数値は、そのジョブが `coverage-summary.json` の `total` から job summary とログに書いたもの。

| | 行 | 分岐 | 計測 |
| --- | ---: | ---: | --- |
| unit | 7480/8984 (83.25%) | 5798/7932 (73.09%) | 上の run。`vitest_exit_status=0` |

同じ summary の変更箇所は、行 280/310 (90.32%)、分岐 228/335 (68.05%)。未検証は行 15 件、分岐 110 件で、いずれも `src/coverage/cli.ts`、`src/coverage/diff-report.ts`、`src/coverage/git-diff.ts`。比較は pull request の three-dot。ログに出た summary の先頭:

```text
### 差分カバレッジ（unit）

表示のみ。閾値では失敗させない。対象は `src/**/*.ts`（`.d.ts` を除く）の追加・変更行。行は文の開始行。分岐は、その行か条件の行が変更に含まれる未実行の分岐。

| | 行 | 分岐 |
| --- | ---: | ---: |
| 変更箇所 | 280/310 (90.32%) | 228/335 (68.05%) |
| 全体 | 7480/8984 (83.25%) | 5798/7932 (73.09%) |

比較: pull request の three-dot

#### 未検証の行

- `src/coverage/cli.ts:80`
- `src/coverage/cli.ts:98`
- `src/coverage/cli.ts:102-104`
```

続きは同じジョブのログにある。`coverage_elapsed_seconds=13`、`vitest_exit_status=0` で終わっている。

## CI の所要時間

上と同じ run で比べる。カバレッジ付き unit はカバレッジなしより 0.14 秒長い。ジョブは並列で、`diff coverage` は `typecheck, unit, e2e` より先に終わった。workflow の待ち時間は増えていない。

| | 秒 | 出典 |
| --- | ---: | --- |
| unit（カバレッジなし） | 12.06 | `typecheck, unit, e2e`（[112056750200](https://github.com/marufeuille/xteink-read-later/actions/runs/37397456092/job/112056750200)）の Vitest Duration。ステップ `Unit tests` は 2026-10-06T01:06:49Z から 2026-10-06T01:07:02Z（Actions API の秒精度で 13 秒） |
| unit（カバレッジあり） | 12.20 | `diff coverage` の Vitest Duration。スクリプトが出した `coverage_elapsed_seconds=13` は `date +%s` の整数差（`npm run test:unit:coverage`）。ステップ `Unit diff coverage` は 2026-10-06T01:06:36Z から 2026-10-06T01:06:49Z（同じく 13 秒） |
| 差（カバレッジ付き unit − カバレッジなし unit） | 0.14 | 12.20 − 12.06。API の秒精度では 13 − 13 = 0 |
| 並列での待ち増分（coverage job − check job、0 未満は 0） | 0 | `diff coverage` は 2026-10-06T01:06:29Z から 2026-10-06T01:06:51Z（22 秒）。`typecheck, unit, e2e` は 2026-10-06T01:06:31Z から 2026-10-06T01:07:10Z（39 秒）。カバレッジ job の方が 17 秒短い |
