# MAR-56: クリップパイプラインの可読性と Cloudflare Workflows の増分コスト

対象: [MAR-56](https://linear.app/marufeuille/issue/MAR-56)

調査日: 2026-09-20。料金・制限は同日に参照した公式ドキュメントに基づく。この文書は設計比較のみで、本番の Worker / Queue / R2 構成は変更しない。

## 推奨

**いまは Cloudflare Workflows に移さない。** 先に Queue を維持したまま、工程名・入出力・分岐・再試行方針を一箇所に置く（案 1）。

個人用途の試算条件（10 / 50 / 100 記事/日）では、Workers Paid の既存 $5 に対する **Workflows の Cloudflare 増分は $0** になる。判断を分けるのは料金ではなく、可読性の改善幅と、Replay 規則・step 戻り値 1MiB・テスト/障害復旧の作り直しコストである。翻訳 API の再実行削減も、後述の前提では月数十セント規模で、移行理由にはならない。

## 現状

処理は次の 3 箇所に分かれる。

| 場所 | 持っているもの |
| --- | --- |
| `src/pipeline/clip.ts` | fetch/extract のあとに translate → EPUB。成功時の `ClipResult` |
| `src/extract/pipeline.ts` | fetch → extract → 言語判定 |
| `src/queue/clip.ts` | Queue 再試行、job 状態、R2 保存、classify（Jev）。失敗しても OPDS からは隠さない |

ログ上の工程は `queue` / `fetch` / `extract` / `translate` / `epub` / `store` / `classify`（`PIPELINE_STAGES`）。依存は一本道で、分岐は (1) 言語が日本語なら翻訳せず整形のみ (2) エラー種別ごとの再試行 (3) classify 失敗は job を落とさない、の 3 つ。

Queue consumer は **1 メッセージあたりパイプライン全体を再実行**する。`max_retries: 3`。`translate_failed` と `fetch_failed` は最終試行まで、`epub_failed` は 1 回だけ、`extract_failed` / `payload_too_large` / `invalid_url` は再試行しない。後段（EPUB / store）が落ちても、成功済みの翻訳は残らず、OpenAI が再度走る。本文は job レコードに残さない。

HTTP `POST /clip` は Queue に載せて 202 を返す。consumer の wall time 上限は 15 分（Queue consumer の公式制限）。翻訳タイムアウトは 60 秒なので、現状の工程では足りる。

Workers Paid 前提。`wrangler.jsonc` の `limits.cpu_ms` は 30,000。既存課金の起点はアカウントの Workers Paid **月額 $5**（Workers / KV / Hyperdrive / Durable Objects の最低課金。データ転送は課金されない）。

## 比較する案

1. **Queue 維持 + 工程表**: 工程名・入出力・分岐・再試行を 1 ファイルに寄せ、runner が順に呼ぶ。中間結果はメモリ上のみ。再試行はいまと同じくメッセージ単位。
2. **Cloudflare Workflows**: 工程を `step.do` に分け、成功 step の結果を再利用し、step 単位で再試行する。`POST /clip` は Workflow を `create` するか、Queue consumer から起動する。
3. **Queue + 最小チェックポイント**: 案 1 に加え、extract / translate の結果を R2 の短い TTL オブジェクトに書き、再試行時はそこから再開する。Workflows は使わない。

## 公式料金・枠・制限（確認日 2026-09-20）

出典の最終更新日はページ側の表記。

### すでに払っているもの（増分ではない）

| 項目 | Workers Paid | 出典 |
| --- | --- | --- |
| アカウント最低課金 | **$5 / 月** | Workers pricing（2026-08-28 更新） |
| Workers リクエスト | 月 1,000 万件込み、超過 $0.30 / 100 万件 | 同上。subrequest は課金されない |
| CPU 時間 | 月 3,000 万 CPU ms 込み、超過 $0.02 / 100 万 CPU ms。待ち時間は課金されない | 同上 |
| Queue consumer CPU | デフォルト 30 秒、最大 5 分。wall time 最大 15 分 | Workers limits / Queue ドキュメント |

### Workflows 固有（Workers Paid）

[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)（2026-07-21 更新）。CPU とリクエストは Workers Standard と同じ SKU を共有する。step / storage の課金は [changelog](https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/) どおり **2026-08-10 以降**（調査時点ですでに適用開始日を過ぎている）。

| 単位 | 込み | 超過 |
| --- | --- | --- |
| リクエスト（Workflow 起動。step はリクエストに数えない。subrequest も追加課金なし） | Workers と共有の月 1,000 万件 | $0.30 / 100 万件 |
| CPU ms（待ち・`step.sleep`・アイドルは含まない） | Workers と共有の月 3,000 万 | $0.02 / 100 万 CPU ms |
| Storage（GB-month。実行中・失敗・sleep・完了を含むピーク日次平均） | 1 GB-month | $0.20 / GB-month |
| Steps（rollback と **step の再試行は含めない**。`step.sleep` / `waitForEvent` は含む） | 月 50 万 | $0.80 / 追加 10 万 |

保持期間の既定は Paid で完了インスタンス **30 日**（Free は 3 日）。`retention` で短くできる。削除は数分遅れて枠に反映される。

主な制限（[limits](https://developers.cloudflare.com/workflows/reference/limits/)、2026-06-15 更新）:

- 非ストリームの step 戻り値 **1MiB**。大きい HTML / EPUB は R2 に置き、参照だけを返す。
- インスタンスあたり永続状態 1GB（Paid）。
- step あたり wall time 無制限。CPU は Worker と同じ（既定 30 秒、最大 5 分）。
- 完了インスタンスの保持 30 日。
- instance ID は 100 文字、`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`。現行 `job_[a-f0-9]{32}` はこの形に入る。

### Queue / R2（パイプラインがすでに使う）

| 項目 | Workers Paid 込み | 超過 | 出典 |
| --- | --- | --- | --- |
| Queue 操作（64KB 単位の write / read / delete） | 月 100 万 | $0.40 / 100 万操作 | Workers pricing Queues 節 |
| メッセージ保持 | 既定 4 日、最大 14 日 | — | 同上 |
| R2 Standard ストレージ | 10 GB-month | $0.015 / GB-month | [R2 pricing](https://developers.cloudflare.com/r2/pricing/)（2026-08-07 更新） |
| R2 Class A / B | 月 100 万 / 1,000 万 | $4.50 / $0.36 per 100 万 | 同上。egress は R2 直は無料 |

成功 1 メッセージはおおむね write + read + delete の 3 操作。再配信は read が増える。

### 翻訳 API（Cloudflare 外。再実行削減の比較用）

現行モデルは `gpt-4o-mini`。[OpenAI のモデルページ](https://developers.openai.com/api/docs/models/gpt-4o-mini)（調査日時点）: 入力 $0.15 / 1M token、出力 $0.60 / 1M token。classify（Jev / OpenRouter）は job を失敗させない。再実行されても Cloudflare 増分には入れず、別枠として触れる。

## 試算条件（実測ではなく例）

実績の利用量ではない。感度を見るための固定値。

| 記号 | 値 | 意味 |
| --- | --- | --- |
| \(D\) | 30 | 月の日数 |
| \(N\) | 10 / 50 / 100 | 記事/日（clip 成功を目指す投入） |
| \(M = N \times D\) | 300 / 1,500 / 3,000 | 記事/月 |
| 工程数 | 6 | fetch, extract, translate, epub, store, classify。`queue` は起動側 |
| CPU | 記事あたり 2,000 ms | 抽出と EPUB を多めに見た値。fetch / 翻訳待ちは CPU に入れない |
| 翻訳率 | 50% | 英語など、課金対象の翻訳が走る割合 |
| 翻訳トークン | 入力 4,000 + 出力 4,000 | 記事あたりの例 |
| 翻訳後再試行率 \(r\) | 10% | 翻訳成功後に EPUB/store が落ち、Queue が全体再実行する割合。未計測 |
| その他再試行 | fetch/translate 失敗で 10% が 1 回余分に配信 | Queue 操作の感度用 |
| Workflow 中間状態 | 250 KB / インスタンス | HTML + 抽出 JSON。EPUB 本体は R2。保持 30 日 |
| 待ち時間 | 翻訳 5–60 秒 wall | Workers / Workflows とも CPU 課金対象外 |
| OPDS 閲覧 | 含めない | clip パイプラインの増分だけを見る |

### 計算式

Workers 基本料 $5 は全案で同じ。**増分**は「案 1（現状に近い Queue）を 0 とした差」。

```
articles_month M = N * 30

queue_ops ≈ M * (3 + 0.1)     # 基本 3 操作 + 10% 再配信の read
workers_requests ≈ M * 3      # POST /clip + consumer 1 回 + job GET 1 回の目安
cpu_ms ≈ M * 2000

workflows_steps = M * 6       # step 再試行は課金対象外
workflows_storage_gb_month ≈ (N * 30日保持 * 250KB) / 1e9
  = N * 30 * 250e3 / 1e9

openai_per_translate = 4000/1e6*0.15 + 4000/1e6*0.60 = $0.003
openai_base = M * 0.5 * 0.003
openai_queue_waste = M * 0.5 * r * 0.003
```

超過料金:

```
bill(x, included, unit, price) = max(0, x - included) / unit * price
```

## 月額増分の比較表

Cloudflare 側は 3 つの \(N\) すべてで、込み枠の内側。金額は **$0.00**（四捨五入ではなく、枠内なので 0）。

| 指標（100 記事/日 = 3,000/月） | 案 1 Queue | 案 2 Workflows | 案 3 Queue+R2 | 込み枠 |
| --- | --- | --- | --- | --- |
| Workers リクエスト目安 | ~9,000 | ~9,000（HTTP create に置換しても同程度） | ~9,000 | 10,000,000 |
| CPU ms | 6,000,000 | 同程度（待ちは含まない） | 同程度 | 30,000,000 |
| Queue 操作 | ~9,300 | 0（Queue 廃止時）〜同程度（起動に残す時） | ~9,300 | 1,000,000 |
| Workflow steps | 0 | 18,000 | 0 | 500,000 |
| Workflow storage | 0 | ~0.75 GB-month | 0 | 1 GB-month |
| R2 追加（チェックポイント） | 0 | 大きな step 戻り値を避けるなら参照用キーのみ | extract/translate の一時オブジェクト。3,000 書き込みと数百 MB 未満 | 100 万 Class A / 10 GB |

同じ式で 10 / 50 記事/日はさらに小さい。

### Cloudflare 増分（Workers Paid $5 の上）

| 記事/日 | 案 1 | 案 2 | 案 3 |
| --- | --- | --- | --- |
| 10 | $0 | $0 | $0 |
| 50 | $0 | $0 | $0 |
| 100 | $0 | $0 | $0 |

感度: ページ HTML を 1MB ずつ 30 日保持すると 100 記事/日で約 3 GB-month → Workflow storage 超過 2 GB × $0.20 = **$0.40/月**。step 戻り値 1MiB 制限があるので、大きいページはそもそも R2 参照になり、この超過は起きにくい。

### 翻訳 API（再実行削減。Cloudflare とは別）

| 記事/日 | 翻訳本体（50%） | 案 1 の再実行増分（\(r=10\%\)） | 案 2 / 案 3 で削れる額 |
| --- | --- | --- | --- |
| 10 | $0.45 | $0.045 | $0.045 |
| 50 | $2.25 | $0.225 | $0.225 |
| 100 | $4.50 | $0.45 | $0.45 |

\(r\) が 2% なら増分は五分の一。classify の再実行は OpenRouter 側で、job 成否には載らない。

**読み方:** 個人用途では Cloudflare 増分は問題にならない。翻訳の無駄も、100 記事/日かつ翻訳後 10% 失敗という強めの仮定で月 $0.45。Workflows を選ぶ理由は費用ではなく、step 単位の再開とダッシュボードの図になる。

## 同じ小さな例でのコード比較

例: fetch のあと「有料壁なら失敗、無料なら extract へ」という分岐を足す。再試行は fetch だけ 3 回、extract はしない。

### 現行（工程と再試行がファイルをまたぐ）

`extract/pipeline.ts` に分岐を足しても、再試行は `queue/clip.ts` の `shouldRetryClipError` を別途直す。classify は pipeline に無く、queue 側だけが知っている。工程を足すたびに「本体」と「再試行」と「ログ stage」の 3 箇所を追う。

```ts
// src/extract/pipeline.ts に足すイメージ
const page = await fetchPage(url)
if (!page.ok) return page
if (isPaywalled(page.value.html)) {
  return err({ kind: 'extract_failed', url, reason: 'paywalled' })
}
const extracted = await extractArticle(page.value)

// src/queue/clip.ts は extract_failed を再試行しない、のまま
```

分岐追加の読みやすさ: **低い**。流れは関数のネストを読めば分かるが、再試行範囲は別ファイル。

### 案 1: 工程表を 1 箇所に置く

```ts
export const CLIP_STAGES = [
  { name: 'fetch', retry: 'transient', input: 'url', output: 'page' },
  { name: 'paywall', retry: 'never', input: 'page', output: 'page' },
  { name: 'extract', retry: 'never', input: 'page', output: 'extracted' },
  { name: 'translate', retry: 'transient', input: 'extracted', output: 'translated' },
  { name: 'epub', retry: 'once', input: 'translated', output: 'epub' },
  { name: 'store', retry: 'transient', input: 'translated+epub', output: 'articleId' },
  { name: 'classify', retry: 'never', failJob: false, input: 'translated', output: 'classification' },
] as const
```

runner が `retry` を見て Queue の `message.retry()` を決める。分岐は `paywall` の戻りで後続を飛ばす。**工程追加は表に 1 行**。中間結果はプロセス内だけなので、Queue 再試行では fetch からやり直し。可読性の主目的は満たし、再実行コストは現状と同じ。

### 案 2: Workflows

```ts
export class ClipWorkflow extends WorkflowEntrypoint<Env, { url: string }> {
  async run(event: WorkflowEvent<{ url: string }>, step: WorkflowStep) {
    const page = await step.do(
      'fetch',
      { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } },
      async () => unwrap(await fetchPage(event.payload.url)),
    )

    const extracted = await step.do('extract', { retries: { limit: 0 } }, async () => {
      if (isPaywalled(page.html)) throw new Error('paywalled')
      return unwrap(await extractArticle(page))
    })

    const translated =
      extracted.language === 'ja'
        ? extracted
        : await step.do(
            'translate',
            { retries: { limit: 3, delay: '5 seconds' } },
            async () => unwrap(await translateArticle(extracted, { OPENAI_API_KEY: this.env.OPENAI_API_KEY })),
          )

    const epubKey = await step.do('epub-and-store', { retries: { limit: 1 } }, async () => {
      const epub = await buildEpub(translated)
      await this.env.ARTICLES.put(/* ... */)
      return articleId
    })

    await step.do('classify', { retries: { limit: 0 } }, async () => {
      await classifyArticle(translated, { OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY })
    })
    return epubKey
  }
}
```

工程追加は `step.do` を 1 本足す。分岐は成功済み step の戻り値で行う（[Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/): メモリ上の乱数や「今の時刻」で分岐しない）。EPUB バイト列は 1MiB を超え得るので **step の戻りに載せない**。Replay 時に `fetchPage` を step の外で呼ぶと再実行される。学習コストはここ。

可読性: **直線の依存と step 単位の再試行は現行より読みやすい**。ただし「Worker の普通の関数」ではなく durable execution になる。

### 案 3: Queue + R2 チェックポイント

案 1 の表に `checkpoint: 'r2'` を translate まで付ける。再試行時は `jobs/{id}/extracted.json` があれば fetch を飛ばす。Workflows の Replay 規則は使わない。実装は store のキー設計と TTL 削除が増える。本文を job に残さない現行方針との差は、「短い TTL の作業用オブジェクトを許すか」。

可読性: 工程表は案 1 と同じ。再開条件の読みやすさは案 2 より落ち、チェックポイント有無の if が増える。

## 可視化（構造図と実行状況）

公式の [Visualizer](https://developers.cloudflare.com/workflows/build/visualizer/)（2026-04-22 更新、ベータ）と [2026-02-03 の発表](https://developers.cloudflare.com/changelog/post/2026-02-03-workflows-visualizer/)。

| 見たいもの | Workflows が出すもの | 現行 Queue で近いもの |
| --- | --- | --- |
| **構造図**（step の並び、if/loop/parallel） | ダッシュボードがソースをパースして図にする。畳み込み可。TS/JS のみ。非既定バンドラは崩れることがある | 無い。ログの `stage` とコードを読む。`clip-status` CLI は直近 stage を表にする |
| **1 実行の状況** | `wrangler workflows instances describe` が step ごとの success/failure、retry、エラー、sleep。API の `instance.status()`。Local Explorer（wrangler 4.82.1+）。GraphQL の step イベント（`STEP_*` / `ATTEMPT_*`） | job の `queued/running/ready/failed` と pipeline JSON ログ。step 単位の履歴は残らない |
| 構造図の上にライブ実行を重ねる | ドキュメント上は別物。Visualizer はパースした構造、実行は instance / メトリクス | 該当なし |

データ系の lineage（R2 キーと工程の対応図）は Workflows も描かない。工程名をコードとログで一致させる必要がある点は同じ。

## 移行工数・テスト・ローカル・障害復旧

| | 案 1 | 案 2 | 案 3 |
| --- | --- | --- | --- |
| 本番構成 | Queue のまま。`wrangler.jsonc` の workflows は足さない | `workflows` バインディング追加。Queue を残すか廃止するか選ぶ | R2 キー追加。Queue はそのまま |
| コード | stage 表 + runner。既存関数を移す。1 PR 規模 | Entrypoint クラス、Replay 規則、idempotent な R2 put、HTTP 202 との対応。Queue 併用なら起動が二重 | チェックポイントの read/write/削除 |
| テスト | いまの fake Queue と unit を流用しやすい | `@cloudflare/vitest-plugin` の `introspectWorkflowInstance`。sleep 無効化、step 結果待ち。既存 fake Queue テストは起動経路だけ残る | チェックポイント有無の再試行ケースが要る |
| ローカル | `wrangler dev` 現状どおり | 同左。Workflows は `--remote` 不可。Local Explorer で instance を見られる | 現状どおり + R2 モック |
| 障害復旧 | 15 分 stale なら再 POST。DLQ なし | instance の retry / terminate / restart。job レコードと instance ID の対応を決める。保持 30 日後は Workflow 側の履歴が消える | チェックポイントが残っていれば再 POST で後半だけ走る。ゴミオブジェクトの掃除が要る |
| リスク | 低い | 中。1MiB、Replay で step 外の fetch が再実行、EPUB を step に載せない | 中の下。チェックポイントと canonical id の不整合 |

案 2 をやるなら Stacked PR 向き: (1) バインディングと空 Workflow (2) 工程移植と R2 参照 (3) HTTP 起動と Queue 削除 (4) テストと CLI。各段階で単独デプロイしても clip が止まらないこと。

## 利点・欠点

| | 利点 | 欠点 |
| --- | --- | --- |
| 案 1 Queue + 工程表 | 調査目的の可読性を、新製品なしで満たす。テストと復旧手順が今の延長。費用 $0。classify を表に載せられる | 後段失敗で翻訳が再実行される。ダッシュボードの構造図は無い |
| 案 2 Workflows | step 単位の再開と再試行が言語に載る。構造図と instance の step 履歴。wall time 15 分の Queue 制限から外れる | Replay 規則の学習。1MiB。テストハーネスの作り直し。可視化はベータ。個人用途では費用メリットがほぼ無い。移行 PR が大きい |
| 案 3 チェックポイント | 翻訳再実行だけ抑えるなら Workflows より小さい。Queue と 202 の契約を維持 | 自前の再開ロジック。本文を一時保存する方針変更。構造図は無い |

## 採用判断に残る事項

1. **可読性の完了条件**を「コード上で工程と再試行が一覧できる」とするか、「ダッシュボードの構造図が要る」とするか。後者だけが案 2 を強く推す。
2. **翻訳の再実行が実際にどれだけ起きているか。** ログの `translate` 成功のあと `epub` / `store` / `queue` 失敗を数え、\(r\) が無視できるなら案 3 も不要。
3. **classify を pipeline 本体に含めるか。** いまは queue 側専用で、工程表を作るときの境界になる。
4. 案 2 に進む場合、**Queue を起動バッファとして残すか、`POST /clip` から `Workflow.create` するか。** 個人用途のバーストは小さく、残す必然は薄い。
5. 大きな HTML を **必ず R2 参照にするか。** 案 2 では 1MiB 制限のため事実上必須。案 1 では今どおりメモリで足りる。

残課題の実装（案 1 の工程表）は本 Issue の範囲外。調査の受け入れ条件を満たしたあとの候補。

## 参考

- [Workflows pricing](https://developers.cloudflare.com/workflows/platform/pricing/)（リダイレクト先 `/workflows/reference/pricing/`）
- [Build your first Workflow](https://developers.cloudflare.com/workflows/get-started/guide/)
- [Visualizer](https://developers.cloudflare.com/workflows/build/visualizer/)
- [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Local development](https://developers.cloudflare.com/workflows/build/local-development/)
- [Vitest Workflow APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#workflows)
