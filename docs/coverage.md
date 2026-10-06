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

数値は推測で置かない。この変更の CI で `vitest run --coverage` が書いた全体値を、run のあとでこの表に入れる。

| | 行 | 分岐 | 計測 |
| --- | ---: | ---: | --- |
| unit | 未計測 | 未計測 | CI run の job summary を転記する |

## CI の所要時間

同じ workflow run で、`typecheck, unit, e2e` の Unit tests（`npm run test:unit`、カバレッジなし）と、`diff coverage` の `npm run test:unit:coverage` の秒数を比べる。ジョブは並列なので、workflow の待ち時間は「カバレッジ job が check job より何秒長かったか」も同じ run から書く。

| | 秒 | 出典 |
| --- | ---: | --- |
| unit（カバレッジなし） | 未計測 | |
| unit（カバレッジあり） | 未計測 | |
| 差（カバレッジ付き unit − カバレッジなし unit） | 未計測 | |
| 並列での待ち増分（coverage job − check job、0 未満は 0） | 未計測 | |
