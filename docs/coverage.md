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
| 変更行 | `pull_request` は PR head（`github.event.pull_request.head.sha`）と base の three-dot。`github.sha` は pull_request では合成マージコミットなので、base 側の変更で行番号が PR のファイルとずれる。`merge_group` と `push` は `github.sha` との two-dot。削除行は含めない |
| ログ | reporter は `text-summary`。差分集計に使う `json` と `json-summary` は残す。ファイルごとの表は出さない |
| 通常の unit | `npm run test:unit` はカバレッジなしのまま。成否は `typecheck, unit, e2e` が見る |

全体の行・分岐は Vitest が書く `coverage-summary.json` の `total.lines` と `total.branches`。差分の行・分岐は上の定義で、変更された実行行と変更に含まれる分岐だけを数える。

## いまの全体

1回測った。commit `320683c18005871c04201a1d923457f50a5d3e89`、workflow run [37397456092](https://github.com/marufeuille/xteink-read-later/actions/runs/37397456092) の `diff coverage` ジョブ（[112056750185](https://github.com/marufeuille/xteink-read-later/actions/runs/37397456092/job/112056750185)）。数値は、そのジョブが `coverage-summary.json` の `total` から job summary とログに書いたもの。

| | 行 | 分岐 | 計測 |
| --- | ---: | ---: | --- |
| unit | 7480/8984 (83.25%) | 5798/7932 (73.09%) | 上の run。`vitest_exit_status=0` |

同じ summary の変更箇所は、行 280/310 (90.32%)、分岐 228/335 (68.05%)。未検証は行 30 行（15 範囲）、分岐 107 件で、いずれも `src/coverage/cli.ts`、`src/coverage/diff-report.ts`、`src/coverage/git-diff.ts`。比較は pull request の three-dot（この計測の `HEAD_SHA` は当時の `github.sha`）。ログに出た summary の先頭:

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

## 認証まわりのミューテーションテスト（MAR-192）

Stryker 10.0.0（`@stryker-mutator/core` と `@stryker-mutator/vitest-runner`）で、認証を担う関数があるファイルだけを手動で変異させた。PR や push では走らない。閾値は `thresholds.break: null`。Stryker Dashboard にも送らない。

対象は次の5ファイル。Stryker はファイル単位なので、認証の関数と同じファイルにある補助も変異に含まれる。

| ファイル | 選んだ理由 |
| --- | --- |
| `src/http/auth.ts` | clip の Bearer、OPDS の Basic、smoke 用ハッシュの比較 |
| `src/http/access-identity.ts` | Cloudflare Access のメール |
| `src/http/candidate-session.ts` | Access 経路の CSRF HMAC と比較 |
| `src/http/clip-web-auth.ts` | Web の Bearer / Access の分岐と CSRF の拒否 |
| `src/digest/confirm-link.ts` | まとめ QR の署名・検証・期限。同じファイルに公開 origin の判定もある |

実行は `npm run test:mutation`。中身は `scripts/prepare-stryker-vitest.ts` のあと `stryker run`。設定は `stryker.config.json`（`coverageAnalysis: perTest`、concurrency 4、`timeoutMS` 20000、`timeoutFactor` 2.5）。GitHub では `.github/workflows/mutation.yml` の `workflow_dispatch` だけ。`permissions: contents: read`。secret は無い。checkout と setup-node は既存の action。

`@stryker-mutator/vitest-runner` 10.0.0 はスイート名を空白でつなぐ。Vitest 5 は `fullTestName` を ` > ` でつなぎ、一致しないテストを skip する。パッチ前は変異ごとのテストが 0 件になり、ほとんどが Survived と出た。その回数は公式の数字にしない。`prepare-stryker-vitest.ts` が runner の2ファイルを `join(' > ')` に置換してから計測する。置換対象が無いとそこで止まる。下の2回は、この置換のあとである。

スコアは Stryker の表のとおり。total は `(killed + timeout) / 全変異`、covered は `(killed + timeout) / (全変異 - no coverage)`。百分率は表の小数第2位。内訳の合計はどちらも 506。

計測環境は Node v22.22.2、Vitest 5.0.1。時間は Stryker の `Done in` と、`npm run test:mutation` のシェル経過（準備スクリプトを含む）。

### 回帰テストの前

| ファイル | total | covered | killed | timeout | survived | no coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 合計 | 69.17 | 74.47 | 348 | 2 | 120 | 36 |
| `src/digest/confirm-link.ts` | 63.78 | 72.25 | 125 | 0 | 48 | 23 |
| `src/http/access-identity.ts` | 69.23 | 69.23 | 9 | 0 | 4 | 0 |
| `src/http/auth.ts` | 73.20 | 75.94 | 140 | 2 | 45 | 7 |
| `src/http/candidate-session.ts` | 60.71 | 68.00 | 17 | 0 | 8 | 3 |
| `src/http/clip-web-auth.ts` | 76.00 | 79.17 | 57 | 0 | 15 | 3 |

Stryker の所要は 1分45秒。シェル経過は 107 秒。

### 回帰テストのあと

足したテストは `test/auth-boundaries.test.ts`。ログアウト先は `test/access-identity.test.ts` で `/cdn-cgi/access/logout` そのものを見る。`src/http` と `src/digest` の実装は変えていない。

| ファイル | total | covered | killed | timeout | survived | no coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 合計 | 86.96 | 88.18 | 438 | 2 | 59 | 7 |
| `src/digest/confirm-link.ts` | 81.63 | 83.33 | 160 | 0 | 32 | 4 |
| `src/http/access-identity.ts` | 76.92 | 76.92 | 10 | 0 | 3 | 0 |
| `src/http/auth.ts` | 90.72 | 91.67 | 174 | 2 | 16 | 2 |
| `src/http/candidate-session.ts` | 92.86 | 96.30 | 26 | 0 | 1 | 1 |
| `src/http/clip-web-auth.ts` | 90.67 | 90.67 | 68 | 0 | 7 | 0 |

Stryker の所要は 1分31秒。シェル経過は 92 秒。

前の survived 120 のうち 65 が killed になった。残る 55 に、前は no coverage だった 4 件（下の見送り 3 件と、パターン不一致の早期 return を空にしても後段が `invalid` のままになる 162）が survived として加わって 59。no coverage 36 は、killed 25、survived 4、残 7。timeout は 2 のまま。killed は 348 + 65 + 25 = 438。

timeout の 2 件は `src/http/auth.ts` の比較ループで `i += 1` を `i -= 1` にしたもの（id 226 と 328）。無限ループなので timeout で検出される。survived には入れない。

no coverage の残 7 件は、テストがまだ通らない枝である。id 38（`startSec < 0` の return 本体）、46（Invalid Date の return 本体）、67 と 68（往復不一致の return と catch）、301 と 306（OPDS の期待ユーザーまたはパスワードが nullish のときの空文字）、433（CSRF 比較の期待値が nullish のときの空文字）。

### 回帰テストで kill した survived

分類は「重要な押さえ漏れ」。id は回帰テスト前の survived。

| 押さえ漏れ | id | テスト |
| --- | --- | --- |
| 空白だけの Access メールは拒否し、前後の空白は落とす | 202 | `trims an Access email and rejects whitespace` |
| Bearer / Basic はスキーム全体と、連続する空白だけを受ける | 239, 240, 241, 252, 253, 254 | `parses Bearer only as a whole scheme plus token`、`parses Basic only as a whole scheme plus user and password` |
| コロンの無い Basic は拒否し、空のユーザー名は分ける | 269, 270 | 同上 |
| smoke のハッシュは 64 桁の十六進だけ | 310, 311 | `accepts a smoke hash only when it is exactly 64 hex digits` |
| 保存ハッシュより長い文字列は一致しない | 321 | `rejects a digest that is only a prefix of the stored hash` |
| 本番の資格は principal が `production` | 361, 378 | `names the production principal and does not treat a missing token as smoke` |
| Authorization が無いとき smoke にしない。空のユーザー名やパスワードは、ハッシュが一致しても smoke にしない | 369, 384, 385, 386, 387, 388, 390, 392 | 同上 |
| 401 と 403 の JSON 本文 | 285, 286, 287, 288, 401, 402, 403, 404 | `returns the unauthorized and forbidden bodies` |
| CSRF は空のメールや空のトークンでは空文字。HMAC は 64 桁の十六進で、メールが違えば値が違う | 409, 410, 422, 423, 424, 426, 430 | `binds the Access CSRF token to a non-empty email and clip token` |
| `content-type` のパラメータ前の空白を除いて JSON と判定する | 454 | `treats a JSON content type with a space before the parameter as JSON` |
| JSON の `x-csrf-token` とフォームの `csrf`。無いときと、フォーム解析の失敗は空文字 | 466, 467, 468, 469, 470, 472 | `reads the CSRF token from the JSON header or the form field` |
| ログアウト先は `/cdn-cgi/access/logout` | 434 | `accepts ctx.access email and logs out through Cloudflare Access` |
| 発行日が日付でなければ例外。日が 1 桁でも `09-05` の形に戻す | 12, 61 | `rejects an invalid issue date and keeps a single-digit day` |
| userinfo、クエリ、フラグメント、URL でない文字列は公開 origin ではない | 81, 90, 91, 94, 97, 100 | `accepts only an origin, not userinfo, a query, a hash, or a non-URL` |
| 署名の `/` は `_` になり、長さは 43 | 118 | `signs only with a secret and a non-negative expiry, and verifies the canonical decimal` |
| 空の秘密や負の期限では署名しない。0 は署名できる | 123, 129, 130, 132, 133 | 同上 |
| 空の秘密では検証しない。`01` のように正規化すると別の数になる期限は拒否する | 148, 149, 150, 167, 168, 170 | 同上 |

この 65 件の id は、回帰テスト後の report で status が Killed である。

### 残った survived

59 件。等価が 50、見送りが 9。実装の変更は要らない。

| id | 場所 | 分類 | 根拠 |
| --- | --- | --- | --- |
| 0, 1 | `confirm-link.ts:6` トークン正規表現の `^` / `$` | 等価 | アンカーを外しても、署名比較はトークン全文を見る。43 文字でない文字列は長さが違い、結果は `invalid` のまま |
| 4, 5 | `confirm-link.ts:7` 期限正規表現の `^` / `$` | 等価 | 余分な文字は `Number` と `String(expiresAt) !== input` で `invalid` になる |
| 15, 127, 137 | 発行日・空の秘密・負の期限の `TypeError` メッセージ | 見送り | 投げていることはテストが見る。文言は検証の成否を変えない |
| 23, 24, 26, 27, 29 | `issueDateFromDigestQrExpires` の先頭の整数チェック | 等価 | 負数・非整数・NaN は、その後の `startSec < 0`、Invalid Date、時分秒、往復のいずれかで同じく null |
| 35 | `startSec < 0` を消す | 見送り | `digestQrExpiresAt('1970-01-01')`（1177200）だけが、暦日 `1970-01-01` を返すようになる。いまの発行日はそれより後で、`startSec` は正のまま null にならない。1970 年に合わせる実装変更はしない |
| 36 | `startSec < 0` を `<=` にする | 等価 | 増えるのは `startSec === 0` だけである。その時刻は +9 時間で 09:00 になり、時分秒チェックが null を返す |
| 45 | Invalid Date のチェックを消す | 等価 | Invalid Date の時分秒は 0 ではなく、次のチェックが null を返す |
| 48, 49, 50, 51, 52, 54, 56, 58 | 時分秒が 0 でない期限を拒否する条件 | 等価 | 条件を抜けても、組み立てた暦日の `digestQrExpiresAt` がその期限と一致せず null |
| 63, 65 | その往復チェック自体 | 等価 | 時分秒が 0 のとき往復は一致するので、比較は常に偽。それ以外は前段で null |
| 75, 77, 79 | `workerPublicOrigin` の trim と空文字 | 等価 | URL パーサが前後の空白を除く。空や空白だけはパースに失敗して null |
| 142 | 署名鍵の `extractable: false` を true にする | 等価 | 署名バイト列は変わらない。鍵は外に出さない |
| 158, 159, 162 | トークンや期限の形が違うときの早期 return | 等価 | 早期 return を飛ばしても、数値化か署名比較が `invalid` を返す |
| 203, 204, 205 | Access の `?.` を外す | 等価 | 欠けていると `TypeError` になり、同じ関数の catch が null を返す。メールがあるときの戻り値は同じ |
| 218, 219, 221 | `secretsEqual` の空文字短絡 | 等価 | 片方だけ空でも SHA-256 は一致しない。両方空は `&&` でも不一致のまま |
| 224 | SHA-256 比較ループの `<` を `<=` にする | 等価 | 余分な添字は `undefined ?? 0` で、差分は 0 のまま |
| 236, 238, 249, 251 | `header === undefined` の早期 return | 等価 | 抜けても正規表現は文字列 `"undefined"` に一致せず null |
| 259, 263, 265 | Basic の match が無いときの早期 return | 等価 | 抜けても `atob` が投げ、catch が null を返す |
| 293, 295, 299, 304 | 提示や期待が無いときの `''` を Stryker の目印文字列にする | 見送り | その目印と期待値が一致するときだけ結果が変わる。空どうしや本番のトークンは不一致のまま。目印を期待値に書くテストは仕様を固定しない |
| 326 | 十六進比較ループの `<` を `<=` にする | 等価 | 末尾の `charCodeAt` は NaN で、ビット演算は 0 になり、一致結果は変わらない |
| 416 | CSRF 鍵の `extractable: false` を true にする | 等価 | HMAC の十六進は変わらない |
| 444, 458 | 無い Accept / Content-Type を目印文字列にする | 等価 | その文字列は `application/json` ではないので、JSON 判定は変わらない |
| 455 | Content-Type の `?.trim` を `.trim` にする | 等価 | `split` は少なくとも 1 要素を返すので、`[0]` は常に文字列 |
| 496, 497 | Bearer 成功時の `via: 'bearer'` と空の CSRF | 等価 | 呼び出し側が CSRF と HTML を変えるのは `via === 'access'` のときだけ。空文字も Bearer の CSRF 文字列も、その分岐に入らない |
| 507 | `unauthorizedResponse('bearer')` の引数を空文字にする | 等価 | `'basic'` のときだけ Basic の challenge になる。空文字は Bearer のまま |
| 508 | ログイン案内の `<title>` を空文字にする | 見送り | 本文の h1 と 401 は残る。認証の成否は変わらない |

id の数は 0, 1, 4, 5, 15, 23, 24, 26, 27, 29, 35, 36, 45, 48, 49, 50, 51, 52, 54, 56, 58, 63, 65, 75, 77, 79, 127, 137, 142, 158, 159, 162, 203, 204, 205, 218, 219, 221, 224, 236, 238, 249, 251, 259, 263, 265, 293, 295, 299, 304, 326, 416, 444, 455, 458, 496, 497, 507, 508 の 59。回帰テスト後の report で status が Survived のものと一致する。
