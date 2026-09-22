# Xteink Read Later 開発計画

対象: [Linear project Xteink Read Later](https://linear.app/marufeuille/project/xteink-read-later-b91329ef0ae8)

操作手順の正本は [README](../../README.md)。このファイルは着手時（MAR-30 〜 MAR-40）の計画記録。第 5 節以降の API・データ・実行モデルは当時の契約で、本番の契約ではない。

## いまの実装（2026-09-22）

着手時からの差分。手順と秘密値の置き場所は README。

| 当時 | いま |
| --- | --- |
| `POST /clip` が同一リクエストで抽出〜EPUB まで終わって 200 `ready` | URL を検証して Queue に載せ、**202** `queued`。完成は consumer |
| R2 のみ。D1 は置かない | R2 が記事・購入 EPUB・`jobs/{jobId}.json`。D1 が候補・発見元・情報源・おすすめ判定・まとめ掲載履歴 |
| Queue / Workflows は同期が破綻してから | Queue が 3 本（clip / feed / digest）。Workflows は使わない（[MAR-56](mar-56-pipeline-workflows.md)） |
| 翻訳モデルは未決。調査時点は `gpt-4o-mini` | 本番は OpenAI `gpt-5.6-luna`（[MAR-44 / MAR-71](mar-44-translate-models.md)） |
| OPDS は日付の無い一覧 | `clip` と `ebook` の下に Asia/Tokyo の暦日。まとめは最新 1 冊だけルート |
| 入口は Android の HTTP Shortcuts だけ | それに加え、Access 付きの PC クリップ、候補一覧、RSS/Atom 巡回、朝のまとめ |
| 分類なし | clip 後に Jev で topic / kind（[classification.md](../classification.md)）。失敗しても掲載は残す |
| 候補のおすすめなし | 候補ごとに de-recommend（[de-recommend.md](../de-recommend.md)）。まとめの枠分けに使う |

CI は PR と `main` で typecheck・単体・fixture E2E を回し、緑の `main` だけ `wrangler deploy` する。読む側は CrossPoint JP / Xteink の OPDS。購入 EPUB は `POST /books` で手元ファイルを載せる（書店からは取らない）。CrossPoint で棚を辿って EPUB を取る実機確認は未実施。

以下のフェーズ表は着手当時の順。MVP としては実装済み。第 5 節以降を現行仕様として読まない。

## 1. 何を作るか

スマホで見つけた Web 記事を共有操作だけで送り、必要なら AI で日本語化・整形した EPUB として Xteink X3（CrossPoint JP）から取得して読む、個人用パイプライン。買った EPUB は同じカタログに載せる。

一般的な Read Later サービス（マルチユーザー、管理 UI、読了同期、Kindle/Kobo）は作らない。

## 2. 採用スタック（プロジェクト方針）

| 層 | 選択 |
| --- | --- |
| ランタイム | Cloudflare Workers + TypeScript |
| ローカル | Wrangler dev |
| HTTP | Hono |
| AI | OpenAI API |
| 生成物 | EPUB 3 |
| 保存 | Cloudflare R2 |
| 配送 | OPDS フィード |
| 入口 | Android 共有シート + HTTP Shortcuts |

進め方はプロジェクト記載どおり、**先にローカルで URL → EPUB を通し、その後 Workers / R2 / OPDS / Android 共有に載せる**。この表は着手時のもの。現行は Queue 3 本、D1、OpenRouter（Jev）が加わる。翻訳の本番モデルは `gpt-5.6-luna`。

## 3. Linear Issue の読み方

Issue はすべて Backlog、担当は Masahiro ISHII。Linear 上の `blocks` / `blockedBy` / parent は空で、**プロジェクトへの所属が紐づけ**。依存はパイプライン順から推定する。

```
MAR-30 本文抽出
  → MAR-31 翻訳・整形
    → MAR-32 EPUB 生成
      → MAR-33 ローカル E2E
        → MAR-34 Workers デプロイ
          → MAR-35 R2 保存
            → MAR-36 OPDS
              → MAR-40 Android 共有
MAR-38 認証 ── 公開 endpoint（MAR-34 以降）と Android 共有（MAR-40）の前提
```

MAR-38 は単独チケットだが、公開 Workers と Android 共有の前に入れないと OpenAI 費用が第三者実行される。OPDS 側は CrossPoint JP が HTTP Basic をサポートするため、clip 用 Bearer とは別 cred にする。

## 4. フェーズ

### Phase 0 — 足場（MAR-30 に含める）

Linear に独立 Issue はないが、空リポジトリなので MAR-30 で同時に入れる。

- `wrangler.jsonc`（JSONC、`compatibility_date` は直近、`nodejs_compat`、`observability`）
- Hono エントリ、`wrangler types` で `Env` 生成（手書きしない）
- テストランナー（Vitest 等）と fixture HTML
- `.gitignore` / README の起動手順
- Secret はソースに置かない。ローカルは `.dev.vars`

Workers Free の CPU 10ms では本文抽出と EPUB 生成が落ちる想定。**Paid（デフォルト CPU 30s、必要なら `limits.cpu_ms` を上げる）を前提**にする。HTTP の wall time にハードリミットはない（クライアント接続中）。

### Phase 1 — ローカルパイプライン

| 順 | Issue | ふるまい |
| --- | --- | --- |
| 1 | [MAR-30](https://linear.app/marufeuille/issue/MAR-30) | `POST /clip` が URL を受け、title / author / publishedAt / canonical URL / 本文 HTML を返す |
| 2 | [MAR-31](https://linear.app/marufeuille/issue/MAR-31) | 英語は全文日本語化、日本語は整形のみ。コード・固有名詞は保持。失敗時に抽出結果を失わない |
| 3 | [MAR-32](https://linear.app/marufeuille/issue/MAR-32) | EPUB 3 を生成。タイトル・著者・元 URL・公開日・本文・言語。Xteink で文字化けしない |
| 4 | [MAR-33](https://linear.app/marufeuille/issue/MAR-33) | 1 リクエストで上記を通し、処理時間と失敗箇所がログで分かる。実機で読める |

### Phase 2 — クラウド配送

| 順 | Issue | ふるまい |
| --- | --- | --- |
| 5 | [MAR-34](https://linear.app/marufeuille/issue/MAR-34) + [MAR-38](https://linear.app/marufeuille/issue/MAR-38) の clip 側 | 同じコードを Workers に載せる。`CLIP_TOKEN` なしの変換は拒否。Secret はレスポンス/ログに出ない |
| 6 | [MAR-35](https://linear.app/marufeuille/issue/MAR-35) | EPUB + メタデータを R2 へ。HTTP で取得できる。手動削除できる |
| 7 | [MAR-36](https://linear.app/marufeuille/issue/MAR-36) + MAR-38 の OPDS 側 | OPDS カタログを返す。CrossPoint JP から登録・一覧・ダウンロードできる |

### Phase 3 — スマホ入口

| 順 | Issue | ふるまい |
| --- | --- | --- |
| 8 | [MAR-40](https://linear.app/marufeuille/issue/MAR-40) | Android 共有シート → HTTP Shortcuts → `POST /clip`。成功/失敗が端末で分かる。その後 OPDS から読める |

> 第 5〜12 節は着手時の契約。`POST /clip` の同期 200、D1 なし、同期実行は現行ではない。現行は README と冒頭の表。

## 5. API（着手時の契約）

ライブラリ選定は実装時に委ねる。契約は HTTP と成果物で固定する。

### `POST /clip`

記事クリップの入口。Android の共有ショートカットもこれを叩く。購入 EPUB は `POST /books`。

Request:

```http
POST /clip
Authorization: Bearer <CLIP_TOKEN>
Content-Type: application/json

{ "url": "https://example.com/article" }
```

- `url` は `http` / `https` のみ。それ以外は `400`
- 本番と `wrangler dev` の両方で token を要求する（ローカルも `.dev.vars`）
- 同一プロセスで fetch → 抽出 → 言語判定 → 翻訳/整形 → EPUB まで同期実行する

成功 `200`:

```json
{
  "id": "art_…",
  "status": "ready",
  "title": "…",
  "author": "…",
  "sourceUrl": "https://…",
  "canonicalUrl": "https://…",
  "publishedAt": "2026-01-15T00:00:00.000Z",
  "language": "ja",
  "translated": false,
  "epubPath": "/articles/art_…/book.epub",
  "timingsMs": {
    "fetch": 0,
    "extract": 0,
    "translate": 0,
    "epub": 0
  }
}
```

Phase 1 の途中（MAR-30 完了時点）では `contentHtml` を返し、`epubPath` はまだなくてよい。MAR-33 完了時点で上の形に揃える、としていた。同期の 200 `ready` は現行ではない。いまの `POST /clip` は 202 `queued` で、HTML 本文は返さない。

失敗:

| 状態 | 意味 |
| --- | --- |
| `400` | URL 不正 |
| `401` | token なし / 不一致 |
| `413` | 取得 HTML が上限超過 |
| `422` | 本文抽出不能（`extract_failed`） |
| `500` | EPUB 生成失敗（`epub_failed`） |
| `502` | 対象ページ取得失敗 |
| `503` | 翻訳プロバイダ失敗（抽出結果は失わない。レスポンスに `extracted` を残す） |

`POST /clip` と `POST /clip/` は同じルート。

### `GET /articles/:id`

`meta.json` 相当。OPDS と同じ HTTP Basic。未存在は `404`。未認証は `401`。

### `GET /articles/:id/book.epub`

`application/epub+zip`。OPDS と同じ HTTP Basic。未存在は `404`。未認証は `401`。

### `DELETE /articles/:id`

Bearer 必須。R2 上の当該記事を削除。MAR-35 の手動削除。

### `GET /opds`

OPDS の入り口。`GET /opds` と `GET /opds/` は同じナビゲーションで、中身があるときだけ `clip` と `ebook` に入る。その下は Asia/Tokyo の暦日（`/opds/clip/YYYY-MM-DD`、`/opds/ebook/YYYY-MM-DD`）の取得フィードで、その日の本だけ、新しいものが上。本が無い日と空の棚は出さない。まとめは最新 1 冊だけルートの取得エントリで、日付棚には入らない。取得 URL は `/opds/download/:id.epub` のまま。

CrossPoint 登録の注意: 本番は https、カタログ URL は `/opds`（origin だけや `/opds/` は端末に入れない）、HTTP Basic のみ（`CLIP_TOKEN` は使わない）、空パスワード不可。

### `GET /opds/download/:id.epub`

カタログから辿る取得 URL。中身は `GET /articles/:id/book.epub` と同じ。

### `POST /books`

購入済み EPUB の取り込み。Bearer `CLIP_TOKEN`。multipart（`title` 必須、`author` / `publishedAt` 任意、`epub` ファイル）。翻訳・抽出・外部ショップ fetch はしない。`POST /books` と `POST /books/` は同じルート。

OPDS は CrossPoint JP が **HTTP Basic** のみサポートするため、`Authorization: Basic` を要求する。Bearer は使わない。ユーザー名/パスワードは Workers Secret。空パスワード不可（端末が username-only を送らないため）。

## 6. データ

着手時は D1 を置かず R2 だけにする。現行は候補・情報源・まとめ履歴に D1 を使う。完成 EPUB と job は R2 のまま。

```
articles/{id}/meta.json
articles/{id}/book.epub
```

`id` は clip では canonical URL の SHA-256 先頭、購入 EPUB ではファイルバイトの SHA-256 先頭（推測困難な固定長）。同一キーの再送は **上書き**（最新 EPUB が残る。`createdAt` は初回を維持し `updatedAt` を更新）。購入 EPUB の canonical は `https://purchased.invalid/books/{id}`（外部ショップは fetch しない）。

`meta.json`:

```json
{
  "id": "art_…",
  "title": "…",
  "author": "…",
  "sourceUrl": "https://…",
  "canonicalUrl": "https://…",
  "publishedAt": null,
  "createdAt": "…",
  "updatedAt": "…",
  "language": "ja",
  "translated": false
}
```

OPDS は R2 `list` + 各 `meta.json` で都度生成してよい（個人規模）。カタログ用の別 DB は作らない。

ローカル Phase 1 では R2 なしで、レスポンスまたはローカルディレクトリへ EPUB を出せば MAR-33 を満たせる。MAR-35 で R2 binding に切り替える。

## 7. パイプラインのふるまい

```
URL
 → fetch（redirect 追従、User-Agent 付与、HTML サイズ上限）
 → 本文抽出（title / byline / publishedAt / canonical / content HTML）
 → 言語判定
 → 英語等: OpenAI で日本語化+整形 / 日本語: 整形のみ（再翻訳しない）
 → EPUB 3 生成
 → （Phase 2）R2 保存
```

翻訳方針（プロジェクト記述を契約として固定）:

- 原文の意味を保ち、過度な要約をしない
- コード、API 名、CLI、固有名詞は原文維持
- 専門用語は必要なら初出のみ英語併記
- 見出し構造を保持
- 広告・CTA・ナビは本文に混ぜない
- 日本語記事は原則翻訳しない

言語判定は外部 API に頼まない。`html[lang]` と本文の仮名漢字比率などで `ja` / `non-ja` を決める。曖昧なら `non-ja` として翻訳し、プロンプト側で「既に日本語なら翻訳しない」を保険にする。

画像は MVP で埋め込まない（メモリ 128MB、e-ink、追跡ピクセル）。本文中の画像は除き、代替テキストがあれば残す。

JS レンダリング必須のサイトは対象外。失敗は `422`。

着手時の既定は同期実行。OpenAI 待ちは CPU に入らない。抽出と ZIP が重い場合のみ `limits.cpu_ms` を上げる。Workflows / Queues は同期が実測で破綻してから、としていた。現行の clip は Queue（202）で、Workflows は使わない。

## 8. 設定と秘密

| 名前 | 種別 | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | Secret | 翻訳 |
| `CLIP_TOKEN` | Secret | `POST /clip` / `POST /books` / `DELETE` |
| `OPDS_USERNAME` | Secret | OPDS Basic |
| `OPDS_PASSWORD` | Secret | OPDS Basic |
| `ARTICLES` | R2 binding | EPUB と meta |

token 比較は timing-safe。ログに token・記事全文を出さない。構造化 JSON で stage と所要時間とエラー種別だけ出す。

## 9. モジュール境界

実装の置き場は実行時に決めてよい。責務だけ分ける。

- HTTP（Hono）: 認証、バリデーション、ステータスコード
- fetch/extract: URL 取得と本文抽出。Workers では jsdom 非対応が前提
- language: `ja` / `non-ja`
- translate: OpenAI。入力は抽出 HTML を Markdown 化したもの、出力 Markdown を HTML に戻して EPUB へ
- epub: EPUB 3 バイナリ。XML 禁止 C0 とリモート img は落とす
- store: R2 の get/put/delete/list
- opds: Atom XML

エントリの Worker は薄い。パイプラインは HTTP なしでも呼べるようにし、MAR-33 の「1 コマンドまたは 1 HTTP」の両方に耐える。

## 10. Issue ごとの受け入れテスト

実機確認は CI に載せない。それ以外は fixture とモックで自動化する。

### MAR-30

- `wrangler dev` で起動できる
- fixture の日本語 HTML を与えると、title と本文が返り、`nav` / `script` / 広告相当が本文に含まれない
- fixture の英語 HTML でも同様
- 不正 URL は `400`
- 取得失敗は原因が分かるエラー（`502`）
- 抽出不能は `422`

### MAR-31

- `.dev.vars` に `OPENAI_API_KEY` を置ける（リポジトリに入らない）
- 英語技術記事 fixture: 日本語本文になり、コードブロックが壊れない
- 日本語 fixture: `translated: false` で再翻訳しない
- OpenAI 失敗時: 抽出結果がレスポンスに残る

### MAR-32

- `.epub` が ZIP として壊れない（`mimetype`、`META-INF/container.xml`、OPF、本文 XHTML）
- タイトル・元 URL・言語が入る
- 見出し・段落・コードが本文に残る
- 代表 3 fixture で破損しない
- フォント埋め込みはしない（端末側設定に任せる）

### MAR-33

- `POST /clip` 一発で抽出〜EPUB まで終わる
- 日本語は整形のみ、英語は日本語化
- ログに stage 別 `timingsMs` と失敗 stage が出る
- 出力 EPUB を Xteink X3 で開ける（手動）

### MAR-34

- Workers 上の URL へ `POST /clip` できる
- 翻訳〜EPUB まで完了する
- Secret がレスポンス/ログに出ない
- 代表記事 3 本でローカル結果との差が読書に支障ない（手動）

### MAR-35

- Workers から R2 へ保存できる（`wrangler dev` のローカル R2 で可）
- HTTP で EPUB を取得できる
- 同一 canonical の再送は上書き
- `DELETE /articles/:id` で消える

### MAR-36

- `/opds` が Atom/OPDS としてパースできる
- 新しい記事が上
- acquisition link から EPUB を取れる
- CrossPoint JP にフィード登録し、一覧表示・ダウンロード・読書ができる（手動）

### MAR-40

- Android の共有シートから HTTP Shortcuts を起動できる（手動）
- 開いている記事 URL を Bearer `CLIP_TOKEN` 付きで `POST /clip` できる
- 成功/失敗が Android 上で分かる
- 英語記事送信後、OPDS から日本語 EPUB を取得できる（手動）

ネイティブアプリは作らない。ショートカット本体はリポジトリにバイナリを置かず、再現手順（URL、ヘッダ、JSON）を README に書く。

### MAR-38

- token なし / 不正 token の `POST /clip` は `401`
- token は git に入らない
- OPDS は Basic なし `401`、正しければカタログ取得可
- `/clip` を第三者が叩いても OpenAI を任意実行できない
- Xteink の取得導線（OPDS Basic）は Bearer と混線しない

## 11. リスク

| リスク | 扱い |
| --- | --- |
| サイトが CF データセンター IP や bot UA を弾く | 代表 3 本で先に確認。失敗は `502`/`422`。Browser Rendering は MVP 外 |
| HTML が大きいと isolate 128MB | 取得サイズ上限を設け、画像を埋め込まない |
| 抽出+ZIP が CPU 30s を超える | Paid で `cpu_ms` を上げる。まだ足りなければその時点で Workflows |
| 一部サイトは JS 必須 | MVP 外。失敗を明示 |
| OPDS の方言 | 最小 Atom + `application/epub+zip` acquisition。実機で合わせる |
| Workers Free の 10ms | Paid 前提。Free では成立しない |

## 12. 未決事項（推奨デフォルト付き）

実装時はデフォルトで進めてよい。覆すなら計画を更新する。

| 項目 | 推奨 |
| --- | --- |
| 同一 URL 再送 | canonical 単位で上書き |
| 画像 | 埋め込まない |
| 言語判定 | `html[lang]` + 仮名漢字比率。曖昧なら翻訳する |
| OpenAI モデル | `gpt-5.6-luna`（MAR-71。プロンプトと JSON 契約は据え置き。`temperature` は送らない） |
| 実行モデル | 着手時は同期 HTTP。現行は clip / feed / digest の Queue。Workflows は使わない |
| DB | 着手時は R2 のみ。現行は R2 に加え、候補・情報源・まとめ履歴の D1 |
| OPDS 認証 | HTTP Basic（CrossPoint JP 互換） |
| clip 認証 | Bearer `CLIP_TOKEN` |
| カスタムドメイン | 最初は `*.workers.dev`。実機 HTTPS で問題が出たら付ける |
| 代表記事 3 本 | 実装時に日本語技術ブログ / 英語技術ブログ / 英語ニュースを固定 fixture にする |

## 13. 計画のあとに入ったもの

MVP（抽出〜OPDS〜Android 共有〜購入 EPUB）のあとに入ったもの。契約の正本は README。

- MAR-44 / MAR-71: 翻訳は `gpt-5.6-luna`。メモは `mar-44-translate-models.md`
- MAR-45: clip は Queue。`POST /clip` は 202。Workflows には移さない（`mar-56-pipeline-workflows.md`）
- MAR-57: 記事分類。`docs/classification.md`
- MAR-73: 読書候補。MAR-74: RSS/Atom。MAR-75: 候補から clip へのポインタ。MAR-76: おすすめ度（`docs/de-recommend.md`）
- MAR-77: まとめ EPUB の日付別 identity（`docs/daily-opds.md`）。朝のまとめは `DIGEST_QUEUE` と 06:00 Asia/Tokyo の Cron
- MAR-84: OPDS を `clip` / `ebook` と Asia/Tokyo の暦日に分ける
