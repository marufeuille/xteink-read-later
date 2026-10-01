# Checkly — Access 外形監視（as-code）

[MAR-151](https://linear.app/marufeuille/issue/MAR-151)。正本はここの `ApiCheck` 定義。ダッシュボードでモニターを手作りしない（初回の Hobby アカウントと API key 作成だけ UI）。

## 何を見るか

| logicalId | URL | 期待 |
| --- | --- | --- |
| `xteink-books-access-wall` | `GET …/books` | **302**、`Location` に `cloudflareaccess.com`。`followRedirects: false` |
| `xteink-digest-send-no-access` | `GET …/digest/send` | **404**（Access に飛ばない）。`followRedirects: false` |

朝晩ヘルス（`/opds`・`/candidates.json`）とは別。合否の説明は [docs/health-checks.md](../../docs/health-checks.md)。

## 前提（Hobby $0）

1. Masahiro が [Checkly Hobby](https://www.checklyhq.com/pricing/) でアカウント作成（クレカ不要の表記）。
2. Checkly の **Account settings → API keys** で API key を発行。Account ID も控える。
3. アラート用 Email を Masahiro の常用アドレスに（Ops の webhook/Linear 連携は後から可）。

値はリポジトリ・PR・コミットに書かない。

## ローカル / Ops からの deploy

```bash
cd infra/checkly
npm install
export CHECKLY_API_KEY=…          # シェルだけ。ファイルに書かない
export CHECKLY_ACCOUNT_ID=…       # 同上
npx checkly test                  # 本番へ 1 回叩いて断言確認
npx checkly deploy                # アカウントへ反映
```

`npx checkly destroy` はプロジェクトごと消す。誤実行に注意。

## GitHub Actions（後続）

マージ後に CI から `checkly deploy` するときは、リポジトリ Secrets に例えば次を置く（名前は CI 側で決める）:

| Secret（例） | 中身 |
| --- | --- |
| `CHECKLY_API_KEY` | Checkly API key |
| `CHECKLY_ACCOUNT_ID` | Checkly Account ID |

この PR では workflow は足さない。秘密のコミットは禁止。

## 採用しないもの（短い）

- **Cronitor** — 同様に無料で断言可だが、チームは Checkly（as-code）を選んだ
- **UptimeRobot Free** — 404 を UP にするカスタムステータスが有料
- **Cloudflare Health Checks** — Free では不可（Pro+）
