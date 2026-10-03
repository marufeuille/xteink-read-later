# デイリーまとめ EPUB の識別子と旧号

[MAR-77](https://linear.app/marufeuille/issue/MAR-77) の検証記録。日付別 identity と「最新 1 冊だけ」は本番のまとめに入っている。04:00 Asia/Tokyo のフィード巡回と、同じ時刻の要約配信（`DIGEST_QUEUE`）も動く。選択枠と手動の `POST /digest` は README。

## 結論

翌日号をカタログキャッシュや同名ファイルと取り違えないため、**JST の暦日ごとに新しい identity を切る**。

| 項目 | 方式 |
| --- | --- |
| 暦日 | `Asia/Tokyo`。`2026-09-20T15:00:00.000Z` から 21 日 |
| canonical URL | `https://daily.invalid/digest/YYYY-MM-DD`（fetch しない） |
| article ID | その URL の SHA-256 先頭（既存の `art_`） |
| OPDS entry ID | `{origin}/articles/{id}` |
| 取得 URL | `{origin}/opds/download/{id}.epub` |
| ファイル名 | `{id}.epub` |
| EPUB `dc:identifier` | `urn:xteink:daily:YYYY-MM-DD` |
| タイトル | `まとめ YYYY-MM-DD` |
| カタログ | デイリーは **最新 1 冊だけ**、`/opds` の取得エントリ。`clip` / `ebook` の日付棚には入れない。クリップや購入 EPUB は消さない |
| HTTP | `GET /opds` と EPUB 取得は `Cache-Control: no-store` |
| 端末の旧号 | カタログから消えるだけ。端末内ファイルの削除は利用者 |

同じ JST 日の再実行は同じ ID に上書きし、増殖しない。

## 2 日分の比較

仮のまとめ EPUB を 2026-09-20 と 2026-09-21 で生成して比較した。

| 項目 | 同じ日の再生成 | 翌日 |
| --- | --- | --- |
| OPDS entry ID | 同じ | 違う |
| 更新日時 | 新しくなる | 違う entry として新しくなる |
| 取得 URL | 同じ | 違う |
| EPUB 識別子 | 同じ | 違う |
| ファイル名 | 同じ | 違う |

安定スロット（`…/digest/current` のような固定 ID）では、entry ID・取得 URL・ファイル名が翌日も一致する。`<updated>` だけ変えて上書きする方式は、CrossPoint が再取得する前提になり、未確認なので採用しない。

## 実機

2026-09-30 に CrossPoint 実機で、https の `/opds` 登録、`clip` と `ebook` の日付棚、最新 digest の閲覧、EPUB 取得、再クリップ後の日付棚掲載まで通った。サーバ側は日付別 identity と最新 1 冊に固定したまま。

## 運用

- カタログを「同じ本の更新」に見せない。翌日は別 entry、別 URL、別ファイル名にする。
- OPDS と EPUB に `no-store` を付け、中間キャッシュが前日号を返さないようにする。
- タイトルに日付を入れ、一覧だけ見ても何日号か分かるようにする。
- 端末に残った旧号はサーバから消えない。利用者本人が消す。
- 要約が 0 件の日、または実行が失敗した日は、サーバのデイリーをカタログから外す。クリップと購入 EPUB は残す。
- QR から全文を送った記事は、その号の弱いいいねとして残る。載ったが送っていない記事は普通以下で、嫌いとしては扱わない。観測は [workers-logs.md](workers-logs.md) の `digest_interest` と D1 の突合。
- 今の興味メモは QR とは別軸。近い候補を、すでに同じ枠へ入っているものの中で前に出す。合わない候補は落とさない。メモを空にすると、この並びは無い。
