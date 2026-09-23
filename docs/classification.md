# 記事分類（MAR-57）

clip した記事に、Jev で話題と種類を付ける。OPDS の棚は話題ではなく日付にする（[MAR-84](https://linear.app/marufeuille/issue/MAR-84)）。`GET /opds` は `clip` と `ebook` の入口で、その下は Asia/Tokyo の暦日。`clip` の暦日は初回保存（Clip した時刻）で、記事の公開日ではない（[MAR-92](https://linear.app/marufeuille/issue/MAR-92)）。分類に失敗しても記事は隠さない。

## プロバイダ

試行は **OpenRouter** の Decisions API を使う。

| 候補 | 使うか | 理由 |
| --- | --- | --- |
| OpenRouter `POST /api/alpha/decisions` | 今回 | 入金済みですぐ使える。Jev の実体は TypeSafe。価格は公式と同じ入力 $0.042/MTok、出力無料 |
| 公式 `POST https://api.typesafe.ai/v1/systemone` | あとで差し替え可 | early access / waitlist。リクエスト形 `{ state, questions }` は同じ |
| Cloudflare Workers AI `typesafe/jev` | あとで差し替え可 | この Worker には合う。サードパーティ扱いで AI Gateway の Unified Billing が要る |

クライアントは `{ state, questions }` だけ知っている。モデルは `typesafe/jev-1.13` をピン留めする。`jev-latest` は試行の比較がぶれる。

Secret は `OPENROUTER_API_KEY`。未設定・空なら Jev は呼ばず `status: "skipped"`。

## 分類体系 `topic-kind-v1`

話題と種類は混ぜない。棚に出すのは各1つ。候補に無いものはコード側で `uncategorized` にする。

### topic（探すときの棚）

| id | 意味 |
| --- | --- |
| `tech` | ソフトウェア、プログラミング、クラウド、インフラ、ガジェット、工学 |
| `science` | 自然科学、医学、学術研究 |
| `society` | 政治、経済、社会問題、法律 |
| `culture` | 本、映画、音楽、ゲーム、アート、エンタメ |
| `life` | 仕事術、健康、旅行、日常、個人の経験 |
| `uncategorized` | 低確信、API 失敗、未実施、購入 EPUB |

### kind（書き方）

| id | 意味 |
| --- | --- |
| `explainer` | 解説、ハウツー、チュートリアル、技術ドキュメント |
| `news` | ニュース、速報、製品発表、リリースノート |
| `essay` | エッセイ、意見、体験談、コラム |
| `uncategorized` | 同上 |

OPDS の棚は topic ではなく日付にする。Web 記事は `clip`、購入本は `ebook` で、見返しが少ないので topic / kind の棚は作らない。`clip` は `createdAt` の Asia/Tokyo 暦日（公開日では分けない）。`ebook` は読める `publishedAt` を優先し、空または解釈できないときだけ `createdAt` に倒す。topic と kind は記事メタに残す。

## 分岐

- 入力は翻訳後のタイトルと本文 excerpt（最大 6000 字）。全文は送らない。Markdown 化の前に HTML を 16000 字で切る。
- Choice を2つ、1リクエストで聞く。`criteria` のキーだけを返す。
- 確信度が **0.7 未満** の軸は `uncategorized`。Jev の選択は `decidedTopic` / `decidedKind` に残す。
- 両方 0.7 以上なら `status: "classified"`。片方でも足りなければ `low_confidence`。
- `criteria` に無いラベルは `uncategorized` / `low_confidence`（API 失敗の `failed` とは分ける）。
- HTTP 失敗・タイムアウト（8秒）・形が違う応答は `failed`。clip 自体は `ready` のまま。
- 失敗理由は `errorCode`（`classify_http` / `classify_timeout` / `classify_invalid_payload` / `classify_internal`）。classify ログの `errorKind` にも同じ値を出す。本文や API の生文は出さない。
- キー未設定は `skipped`。購入 EPUB は Jev を呼ばず `skipped`。
- Queue の `attempt` は使わない。分類は run ごとに最大1回。
- EPUB と `skipped` の meta を先に保存してから分類する。分類結果は meta だけ更新する。isolate が分類中に死んでも掲載は残る。
- `clip:status` の工程一覧は `store` の次に `classify`。job にその工程が無いときだけ「不明」。分類失敗は `classify` 行が「失敗」になり、clip は `ready` のまま。
- 再分類の最小手段は同じ URL の `POST /clip`（新しい `runId`）。管理画面は作らない。

## まだやらないこと

- topic / kind による OPDS の棚。日付棚（`clip` / `ebook`）は入っている（[MAR-84](https://linear.app/marufeuille/issue/MAR-84)）。CrossPoint で棚を辿って EPUB を取る実機確認は未実施。
- 抽出検品と自動修復。判定の記録から始める。
- 翻訳品質の検品。
- 原文を別冊にすること。
