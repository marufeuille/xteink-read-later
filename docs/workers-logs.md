# Workers Logs

`src/log.ts` は `console.log` にオブジェクトを渡す。Workers Logs はそのフィールドを索引する。`JSON.stringify` した文字列は message 1本になり、`event` や `errorKind` では絞れない。

URL、本文、API token はログに足さない。`message` に載せるのは `event` と、`stage` / `clipOutcome` / `status` / `result` / `action` / `outcome` / `errorKind` / `failurePoint` のうち英数字と `_` だけの値。

## フィールド

| `event` | 日次で見る値 |
| --- | --- |
| `pipeline` | `stage`, `durationMs`, `errorKind`。job が `ready` / `failed` になったログだけ `clipOutcome` |
| `daily_digest` | `status` = `published` / `empty` / `failed` |
| `opds_download` | 件数。`durationMs` と `articleId` |
| `feed` | `stage` = `collect`。失敗だけ `errorKind`。`internal_error` だけ `failurePoint`（`fetch` / `parse` / `store` / `unknown`）。`payload_too_large` だけ `bytes`（数値）。成功に `errorKind` は無い |
| （invocation） | `$workers.outcome` = `exceededCpu` |

`pipeline` で `clipOutcome` の無い `errorKind` は工程の失敗や再試行である。clip の失敗件数には数えない。`feed` の `errorKind` は収集の失敗で、下の日次クエリに含める。`site_recovery` の `url` は従来どおり残す。`message` には入れない。

`feed_schedule`（`src/log.ts` の `logFeedSchedule`）は別イベントで、`queued` / `failed` / `durationMs` だけである。`errorKind` は無いので、この保存クエリには入れない。

`candidate_recommend` は判定の結果（`evaluated` / `low_confidence` / `insufficient_material` / `skipped` / `failed`）を出す。フィード収集で予算スキップのまま残る `unevaluated` は候補ごとに出さない。有料記事など、呼ぶ前に別の理由で残った `unevaluated` は出す。

## 日次（Cron のあと）

Cron は `0 19 * * *`（UTC 19:00、日本時間 4:00）。そのあと、時間範囲を直近 24 時間にして下の保存クエリを実行する。

`/ops/summary` は足していない。`exceededCpu` は Worker の外の invocation outcome で、アプリから数えるには Cloudflare API token が要る。Workers Logs は `wrangler.jsonc` の `observability.enabled` で既に有効なので、保存クエリの方が小さい。

### 保存クエリ `xteink-read-later daily ops`

1. [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) で `xteink-read-later` を開く。
2. **Observability** の検索欄に次を貼る。Worker の画面が既にこの script に絞っていても、アカウント全体の Observability で混ざらないよう `$metadata.service` を付けてある。

```text
$metadata.service = "xteink-read-later" AND regex(event, "^(pipeline|daily_digest|opds_download|feed)$")
```

Cloudflare は入れ子の OR（grouped OR）を AND に正規化する。これらの保存クエリに grouped OR は使わない。

`event` は `pipeline`、`daily_digest`、`opds_download`、`feed` のいずれかに一致する。`clipOutcome` や `errorKind` では絞らず、下の Group by で読む。

3. 時間範囲は直近 24 時間。Visualization は count。Group by は `event`, `clipOutcome`, `errorKind`, `status`。
4. ダッシュボードの Save で `xteink-read-later daily ops` として保存する。正本はこのファイル。

読み方:

| 行 | 意味 |
| --- | --- |
| `event=pipeline` `clipOutcome=ready` | clip の ready 件数 |
| `event=pipeline` `clipOutcome=failed` を `errorKind` ごと | clip の failed 件数と内訳 |
| `event=daily_digest` の `status` | `published` / `empty` / `failed` |
| `event=opds_download` | OPDS の EPUB 取得要求件数 |
| `event=feed` を `errorKind` ごと | フィード収集の失敗。`payload_too_large` / `internal_error` / `fetch_failed` / `invalid_feed` / `invalid_url` |
| `event=feed` で `errorKind` が無い | 収集成功（`stage=collect`）。失敗件数には数えない |
| `event=feed` `errorKind=internal_error` の `failurePoint` | 例外が出た段階。`fetch` / `parse` / `store` / `unknown`。URL・本文・例外メッセージは無い |

`feed` 行の `clipOutcome` と `status` は空である。内訳は Group by の `errorKind` に出る。`fetch_failed` と `internal_error` は再試行のたびに 1 行出る。`payload_too_large` と `invalid_feed` は再試行しない。`invalid_url` は不正なキューメッセージで、1 回だけ出して ack する。

`payload_too_large` の `bytes` は、`Content-Length` か受信済みバイト数の数値だけである。`message` には入れない。URL、本文、Secret、例外メッセージは付けない。サイズで絞るときは次を使う。

`hostname` はフィード URL のホスト名だけで、path と query は含めない。情報源が分かっている成功と失敗に付き、`event = "feed" AND hostname = "example.com"` で検索する。

```text
$metadata.service = "xteink-read-later" AND event = "feed" AND errorKind = "payload_too_large"
```

### 保存クエリ `xteink-read-later feed`

フィード収集だけを見るときは次を貼る。

```text
$metadata.service = "xteink-read-later" AND event = "feed"
```

Save で `xteink-read-later feed` として保存する。

`internal_error` の段階は、この検索に `errorKind = "internal_error"` を足し、Group by に `failurePoint` を入れると分かれる。日次の保存クエリの Group by はそのままである。`failurePoint` が無い `internal_error` は、この分類より前のログである。値は呼び出し位置の段階名だけで、例外の `message` は入れない。`fetch_failed` や `invalid_feed` は従来の `errorKind` のままなので `failurePoint` は付かない。

### 保存クエリ `xteink-read-later exceededCpu`

`exceededCpu` はログ行ではなく invocation の outcome である。上の count に混ぜると、その invocation の console 行の数だけ増える。Invocations を count する。

```text
$metadata.service = "xteink-read-later" AND $workers.outcome = "exceededCpu"
```

Save で `xteink-read-later exceededCpu` として保存する。

## 工程

失敗の軸と所要は、たとえば次で絞る。`durationMs` は数値。

```text
$metadata.service = "xteink-read-later" AND event = "pipeline" AND stage = "extract"
```

`clip:status --tail` は、`wrangler tail --format json` の `message` が JSON 文字列でもオブジェクトでも、同じ工程を読む。
