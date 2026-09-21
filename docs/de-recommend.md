# データエンジニア視点のおすすめ度（MAR-76）

候補一覧で読む記事を選ぶ補助。品質の保証ではない。topic/kind 分類（MAR-57）とは別の評価軸。翻訳後本文は使わない。

## プロバイダ

記事分類・PR リスクと同じ OpenRouter Decisions API。クライアントは `evaluateSystemOne`。モデルは `typesafe/jev-1.13`。Secret は `OPENROUTER_API_KEY`。未設定なら Jev は呼ばず `skipped`。

## 評価体系 `de-recommend-v1`

おすすめ度は Choice の3段階。0〜100点は使わない。モデル確信度はおすすめ度ではない。

| grade | 一覧表示 | 基準 |
| --- | --- | --- |
| `recommended` | データエンジニアにおすすめ | データ基盤・パイプライン・ウェアハウス・品質・オーケストレーション・分析基盤・運用に直結し、設計・実装・運用の具体がある |
| `related` | 関連あり | DE の仕事と接点はあるが、周辺技術・概論・発表・ニュース寄り |
| `low_priority` | 優先度低 | DE の仕事との関係が薄い。速報・発表だけで実務の手がかりが無いものも含む |

観点（Noul。true なら固定ラベルを出す。自由文は出さない）:

| id | ラベル | true |
| --- | --- | --- |
| `de_relevant` | DE関連 | データエンジニアの仕事と関連する |
| `has_concreteness` | 設計・実装・運用の具体 | 構成・手順・例・運用上の判断がある |
| `has_verification` | 検証・制約 | 検証・制約・失敗・限界の記述がある |

LLM/AI 記事も DE の仕事との関係で評価する。企業ブログであるだけで下げない。

## 判定状態

未判定 / 材料不足 / 低確信 / 失敗 / キーなし は低評価と混ぜない。どれでも一覧から隠さない。URL 投入と全文送信はそのまま使える。

| status | Jev | おすすめ度表示 |
| --- | --- | --- |
| `unevaluated` | まだ呼ばない（フィード収集の本文ありなど） | 未判定 |
| `skipped` | キー未設定のため呼ばない | 未判定（キーなし） |
| `insufficient_material` | 呼ばない。タイトルやフィード抜粋、取得失敗、抽出失敗 | 材料不足 |
| `evaluated` | Choice が既知ラベルかつ confidence ≥ 0.7 | 3段階の grade |
| `low_confidence` | 応答は来た。門未満または未知ラベル | 低確信（grade は出さない。`decidedGrade` は保存） |
| `failed` | HTTP / timeout / 形不正 | 判定失敗 |

有料記事は登録時に一覧から除外済み。おすすめ判定の対象にしない。

## 入力と再評価

- 入力は翻訳前の抽出 HTML を Markdown にした excerpt（HTML 16000 字、excerpt 6000 字）。
- 1 判定あたり Jev は最大 1 回。通信リトライはしない（タイムアウト 8 秒）。
- 手動 `POST /candidates` は本文を確認できたとき最大 1 回呼ぶ。
- フィード収集は時間予算のため Jev を呼ばない（`unevaluated` または材料不足）。一覧の「判定する」で明示評価する。
- 同じ `de-recommend-v1` と excerpt ハッシュなら再呼び出ししない。失敗は再試行する。基準バージョンが変われば再評価する。`POST /candidates/:id/recommend` の `force` で明示再評価する。
- 本文は D1 に置かない。ハッシュだけ保存する。再評価時は再取得して抽出する。

## 採用基準（人間の期待との比較）

通常 CI では Jev を呼ばない。下表は実装時に決めた例。ライブ試行は `E2E_LIVE=1` の e2e から分ける。

| 例 | 入力 | 期待 |
| --- | --- | --- |
| 日本語の実践（Workers CPU、抽出と EPUB の前提） | `ja-tech.html` 相当の抽出本文 | `recommended` または `related`。企業ブログだから下げない |
| 英語の設定解説（compatibility_date） | `en-tech.html` 相当 | `related` 以上になり得る。英語原文で判定する |
| 企業ブログの深い実装 | パイプライン障害と制約の具体 | `recommended`。出自は理由にしない |
| 技術速報・製品発表 | 短いリリース | `related` または `low_priority` |
| タイトルのみ / 抽出失敗 | `too-short.html` | `insufficient_material`。Jev を呼ばない |
| 有料 | JSON-LD `isAccessibleForFree: false` | 一覧に出さない |

確信度門 0.7 は記事分類と同じ数値だが定数は共有しない。おすすめ度に門の数字は出さない。

## まだやらないこと

自動除外、パーソナライズ、自由文要約、朝のまとめ。
