# Workers Logs

`src/log.ts` は `console.log` にオブジェクトを渡す。Workers Logs はそのフィールドを索引する。`JSON.stringify` した文字列は message 1本になり、`event` や `errorKind` では絞れない。

URL、本文、API token はログに足さない。`message` に載せるのは `event` と、`stage` / `clipOutcome` / `status` / `result` / `label` / `action` / `outcome` / `pingState` / `errorKind` / `failurePoint` のうち英数字と `_` だけの値。

## フィールド

| `event` | 日次で見る値 |
| --- | --- |
| `pipeline` | `stage`, `durationMs`, `errorKind`。job が `ready` / `failed` になったログだけ `clipOutcome`。`clipOutcome=failed` だけ、ホスト名が取れたとき `hostname` |
| `daily_digest` | `status` = `published` / `empty` / `failed` / `running`。`running` は途中進捗（`stage`）。完了は `published` / `empty` / `failed` |
| `digest_interest` | その号の QR から全文送信した弱いいいね。`result` = `recorded` / `already_recorded` / `ignored`。記録できたときだけ `label` = `weak_positive`。`ignored` は `reason` = `not_in_issue` / `invalid_expiry` |
| `opds_download` | 件数。`durationMs` と `articleId` |
| `feed` | `stage` = `collect`。失敗だけ `errorKind`。`internal_error` だけ `failurePoint`（`fetch` / `parse` / `store` / `unknown`）。`payload_too_large` だけ `bytes`（数値）。`fetch_failed` だけ、取れたとき `statusCode`（100–599 の整数）と短い `reason`。成功に `errorKind` は無い |
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
| `event=daily_digest` の `status` | `published` / `empty` / `failed` が号の結果。`running` は途中進捗で、完了件数に数えない |
| `event=daily_digest` の `stage` | `start` / `plan` / `evaluate` / `summarize` / `publish` / `watchdog`。進捗行だけに付く。`published` と `empty` には付けない |
| `event=daily_digest` の `errorKind` | `retry_exhausted` は CPU 超過を含むリトライ枯渇。`internal_error` は最後の試行でも例外が出た印。号全体が止まったときは `status=failed`。1 件だけ飛ばして続行したときは `status=running` のまま `errorKind=retry_exhausted` |
| `event=opds_download` | OPDS の EPUB 取得要求件数 |
| `event=feed` を `errorKind` ごと | フィード収集の失敗。`payload_too_large` / `internal_error` / `fetch_failed` / `invalid_feed` / `invalid_url` |
| `event=feed` で `errorKind` が無い | 収集成功（`stage=collect`）。失敗件数には数えない |
| `event=feed` `errorKind=internal_error` の `failurePoint` | 例外が出た段階。`fetch` / `parse` / `store` / `unknown`。URL・本文・例外メッセージは無い |

`running` は queue の 1 工程（候補ページ、評価 1 件、要約 1 件、EPUB 化）が始まった印である。`exceededCpu` でその invocation が落ちても、この行は日次クエリに残る。最後の配信は重い処理をやり直さず、`retry_exhausted` を残して次の工程へ進むか、EPUB 化なら `status=failed` にする。更新が止まった号は遅延メッセージ `watchdog` が `status=failed` にする。どちらも `event=daily_digest` なので、上の保存クエリのまま見える。

`feed` 行の `clipOutcome` と `status` は空である。内訳は Group by の `errorKind` に出る。`fetch_failed` と `internal_error` は再試行のたびに 1 行出る。`payload_too_large` と `invalid_feed` は再試行しない。`invalid_url` は不正なキューメッセージで、1 回だけ出して ack する。

`payload_too_large` の `bytes` は、`Content-Length` か受信済みバイト数の数値だけである。`message` には入れない。URL、本文、Secret、例外メッセージは付けない。サイズで絞るときは次を使う。

`hostname` はフィード URL のホスト名だけで、path と query は含めない。情報源が分かっている成功と失敗に付き、`event = "feed" AND hostname = "example.com"` で検索する。

clip の `hostname` は、失敗が確定したログ（`event = "pipeline"` かつ `clipOutcome = "failed"`）だけに付ける。値は対象 URL のホスト名だけで、path、query、fragment、userinfo、port、フル URL は含めない。本文、token、Secret、例外メッセージも出さない。URL が壊れていてホスト名が取れないときはフィールドを付けない。推測値は入れない。成功（`clipOutcome = "ready"`）と、再試行中で `clipOutcome` の無い `errorKind` には付けない。`message` には入れない。`event = "pipeline" AND clipOutcome = "failed" AND hostname = "example.com"` で検索する。

```text
$metadata.service = "xteink-read-later" AND event = "feed" AND errorKind = "payload_too_large"
```

`fetch_failed` の `statusCode` は、応答の HTTP ステータスが分かったときだけの整数である。ネットワーク例外やタイムアウトでステータスが無いときはフィールドを付けない。推測値は入れない。`reason` は 48 文字以内の英数字と `_` だけで、`http_error` / `unsupported_content_type` / `unsupported_charset` / `timeout`、または例外の `name`（例: `TypeError`）である。例外の message、レスポンス本文、Content-Type の中身、トークン、フル URL、Secret は出さない。他の `errorKind` には `statusCode` も `reason` も付けない。`message` は `feed collect fetch_failed` のままである。ステータスで絞るときは次を使う。

```text
$metadata.service = "xteink-read-later" AND event = "feed" AND errorKind = "fetch_failed" AND statusCode = 403
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

## 保存クエリ `xteink-read-later digest interest`

朝 digest の QR から全文を送った記録。号に載ったが送っていない記事はログに出ない。そちらの普通以下は、下の D1 の突合で見る。

```text
$metadata.service = "xteink-read-later" AND event = "digest_interest"
```

Save で `xteink-read-later digest interest` として保存する。時間範囲は直近 24 時間。Visualization は count。Group by は `result`, `label`, `reason`。

| 行 | 意味 |
| --- | --- |
| `result=recorded` `label=weak_positive` | その号の掲載集合にあり、QR の POST で全文送信できた。新規の弱いいいね |
| `result=already_recorded` `label=weak_positive` | 同じ号・同じ候補の再送信。最初の `fetched_at` は変えない |
| `result=ignored` `reason=not_in_issue` | QR の送信は成功したが、その期限が指す号の掲載集合に候補が無い。digest のいいねにしない |
| `result=ignored` `reason=invalid_expiry` | 期限が号の日付に戻らない。記録しない |

`issueDate` は `YYYY-MM-DD`。`candidateId` は候補 ID。URL、token、本文は無い。確認ページの GET、有料などで送れなかった POST、`POST /clip`、候補一覧からの送信は、このイベントを出さない。

未取得を含む日次の突合は D1。`ordinary_or_below` は嫌いではなく、掲載されたが QR 送信が無い状態。

```sql
SELECT
  p.issue_date,
  p.candidate_id,
  CASE
    WHEN q.candidate_id IS NOT NULL THEN 'weak_positive'
    ELSE 'ordinary_or_below'
  END AS label,
  q.fetched_at
FROM digest_published_items AS p
LEFT JOIN digest_qr_interest AS q
  ON q.issue_date = p.issue_date
 AND q.candidate_id = p.candidate_id
WHERE p.issue_date = 'YYYY-MM-DD'
ORDER BY label, p.candidate_id;
```

```bash
npx wrangler d1 execute xteink-read-later-candidates --remote --command "SELECT p.issue_date, p.candidate_id, CASE WHEN q.candidate_id IS NOT NULL THEN 'weak_positive' ELSE 'ordinary_or_below' END AS label FROM digest_published_items AS p LEFT JOIN digest_qr_interest AS q ON q.issue_date = p.issue_date AND q.candidate_id = p.candidate_id WHERE p.issue_date = 'YYYY-MM-DD' ORDER BY label, p.candidate_id;"
```

`digest_qr_interest` だけにあって、その号の `digest_published_items` に無い行は上の JOIN に出ない。digest 以外の取得では行を作らない。QR の期限（号の日付から 14 日）が残っている未取得は、次号の順位にはまだ使わない。期限後の未取得は、同じサイトの同点比較で一段だけ下げる。取得済みは一段だけ上げる。サイトは除外しない。

## Cronitor Job telemetry

日次の保存クエリには入れない。クリップか収集のあと、ping が Worker から出たかはこの検索で見る。

```text
$metadata.service = "xteink-read-later" AND event = "cronitor"
```

`outcome` は `sent` / `http_error` / `timeout` / `network` / `redirect_blocked` / `invalid_ping` / `metrics_failed`、または secret が使えないときの `missing_api_key` / `blank_api_key` / `api_key_not_string` / `missing_monitor_key` / `blank_monitor_key` / `monitor_key_not_string`。`pingState` は `run` / `complete` / `fail`。`httpStatus` は数値だけ。ソケット経路では `transport` が `ipv4`。失敗時の `cause` は `dns` / `connect` / `http` / `sockets`。`sockets` はソケットを読めず、`fetch` には戻していない。API key、モニターキー、URL、IP、記事 URL、レスポンス本文、例外メッセージは出さない。`sent` は HTTP 2xx のステータスを読んだ印である。本文が空でも chunked でも `network` / `http` にはしない。Cronitor は資格情報が違っても 200 を返すことがあるので、ダッシュボードとこのログの両方を見る。

クリップの `complete` / `fail` には OpenAI のカスタムメトリクス（`prompt_tokens`、`completion_tokens`、`estimated_usd`）が載る。`run` には付けない。`estimated_usd` は観測用の概算であり、OpenAI の請求額ではない。日本語スキップは 0。名前と断言の例は [health-checks.md](health-checks.md) に書く。このログ行にはメトリクスの値を出さない。

日次ダイジェストの終端（`published` / `empty` / `failed`）も同じ `event=cronitor` に出る。途中の工程と enqueue は出ない。ダイジェストの ping に OpenAI のカスタムメトリクスは付かない。

## 工程

失敗の軸と所要は、たとえば次で絞る。`durationMs` は数値。

```text
$metadata.service = "xteink-read-later" AND event = "pipeline" AND stage = "extract"
```

`clip:status --tail` は、`wrangler tail --format json` の `message` が JSON 文字列でもオブジェクトでも、同じ工程を読む。
