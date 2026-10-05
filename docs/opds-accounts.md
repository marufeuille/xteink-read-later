# OPDS アカウント

本番とスモークの OPDS を足す、消す、替える手順はここが正本。値そのものは書かない。クリップ token と Slack webhook は [deploy-smoke.md](deploy-smoke.md)。

コマンドはリポジトリのルートで実行する。`npx wrangler` は `wrangler.jsonc` の Worker に書く。`gh` はこのリポジトリ（`marufeuille/xteink-read-later`）に書く。未ログインなら先に `npx wrangler login`。

`npx wrangler secret put` は同じ名前があれば上書きする。同時に Worker の version も作る。秘密の値はその version に入る。戻すときの注意は [deploy-smoke.md](deploy-smoke.md)。

## 名前と値の形

| アカウント | 置き場所 | 名前 | 値の形 |
| --- | --- | --- | --- |
| 本番 | Worker secret | `OPDS_USERNAME` | 生のユーザー名。空にしない。コロンは入れない |
| 本番 | Worker secret | `OPDS_PASSWORD` | 生のパスワード。空にしない。ハッシュではない |
| スモーク | GitHub Actions の secret | `SMOKE_OPDS_USERNAME` | 生のユーザー名。本番と同じにしない |
| スモーク | GitHub Actions の secret | `SMOKE_OPDS_PASSWORD` | 生のパスワード。本番と同じにしない |
| スモーク | Worker secret | `SMOKE_OPDS_BASIC_SHA256` | `ユーザー名:パスワード` の UTF-8 バイト列の SHA-256。16進、小文字、64 桁。区切りのコロンは 1 つ。末尾の改行は入れない |

本番の 2 つは GitHub Actions に置かない。スモークの生のユーザー名とパスワードは Worker に置かない。Worker が読むスモーク用の名前は `SMOKE_OPDS_BASIC_SHA256` だけ。古い名前 `SMOKE_OPDS_USERNAME` / `SMOKE_OPDS_PASSWORD` が Worker に残っていても読まない。

名前だけ見るときは次。値は出ない。

```bash
npx wrangler secret list
gh secret list
```

## 混ぜない

照合は本番が先。`src/http/auth.ts` の `resolveOpdsPrincipal` は、`OPDS_USERNAME` と `OPDS_PASSWORD` が合えば `production` を返し、外れたときだけ `SMOKE_OPDS_BASIC_SHA256` を見る。

スモークのユーザー名とパスワードに、本番の値を使わない。本番と同じ値は本番として通る。スモーク用 Basic のカタログは、設定された記事 URL の記事だけを出し、本番記事の題名と id は出さない。本番として通った読み取りには、その制限は掛からない。

本番の `OPDS_PASSWORD` を替えるときに、`SMOKE_OPDS_BASIC_SHA256` が古い本番パスワードのままなら、そのハッシュを先に、または同じ作業で替える。替えないで本番だけ put すると、古いパスワードは本番の照合に外れ、スモークとして通り続ける。新しいハッシュはスモーク専用のユーザー名とパスワードから作る。本番の新しいパスワードを材料にしない。スモークがもともと別のパスワードなら、そのハッシュは本番のローテーションでは触らない。

## 値の作り方

bash と zsh（macOS の既定）の両方で同じコマンドにする。`set -x` は付けない。

`read -rs -p '...' VAR` は使わない。zsh では `-p` が別の意味になり、変数が空になる。空の `SMOKE_OPDS_USERNAME` を登録すると、デプロイスモークは未設定で skip する。プロンプトは `printf`、パスワードの読み取りは `read -rs`。

履歴にはコマンドだけを残す。値は残さない。値をコマンドラインに書かない。`VAR=値` も、`export VAR=値` も、`gh secret set --body` に書いた値も残る。`echo` で値をパイプしない。末尾の改行が入る。渡すときは `printf '%s'`。

登録の前に `echo ${#VAR}` で桁数だけ見る。値は出さない。0 なら入れない。`openssl rand -hex 16` は 32、`openssl rand -hex 32` は 64。`read` は前後の空白を捨てる。パスワードの前後に空白は付けない。

`read` より後ろの行を、同じ貼り付けに入れない。プロンプトが出てから値を打つ。

手で決めるとき。ユーザー名は画面に出る。パスワードは出ない。スモークを手で決めるときは、変数名を `SMOKE_OPDS_USERNAME` と `SMOKE_OPDS_PASSWORD` にする。

```bash
printf 'OPDS_USERNAME: '
read -r OPDS_USERNAME
```

```bash
printf 'OPDS_PASSWORD: '
read -rs OPDS_PASSWORD
```

`read -rs` は Enter の改行を画面に出さない。桁数は別に見る。

```bash
printf '\n'
echo ${#OPDS_USERNAME}
echo ${#OPDS_PASSWORD}
```

ランダムで作るとき。スモーク向け。画面には出さない。手入力より、本番の値を打ち間違えて混ぜにくい。

```bash
SMOKE_OPDS_USERNAME=$(openssl rand -hex 16)
SMOKE_OPDS_PASSWORD=$(openssl rand -hex 32)
echo ${#SMOKE_OPDS_USERNAME}
echo ${#SMOKE_OPDS_PASSWORD}
```

ハッシュ。`sha256sum` があればそれを、無ければ `shasum -a 256` を使う。macOS には `sha256sum` が無い。ユーザー名かパスワードが 0 のときは `0` と出て、ハッシュは作らない。空の入力でも SHA-256 自体は 64 桁になる。`wrangler secret put` は末尾の空白を削って保存するので、ハッシュは保存する文字列と同じ変数から作る。

```bash
if [ "${#SMOKE_OPDS_USERNAME}" -eq 0 ] || [ "${#SMOKE_OPDS_PASSWORD}" -eq 0 ]; then
  echo 0
elif command -v sha256sum >/dev/null 2>&1; then
  SMOKE_OPDS_BASIC_SHA256=$(printf '%s' "${SMOKE_OPDS_USERNAME}:${SMOKE_OPDS_PASSWORD}" | sha256sum | awk '{print $1}')
  echo ${#SMOKE_OPDS_BASIC_SHA256}
else
  SMOKE_OPDS_BASIC_SHA256=$(printf '%s' "${SMOKE_OPDS_USERNAME}:${SMOKE_OPDS_PASSWORD}" | shasum -a 256 | awk '{print $1}')
  echo ${#SMOKE_OPDS_BASIC_SHA256}
fi
```

put と set が終わってから `unset` する。失敗したときは `unset` の前に止めて、同じ変数でやり直す。

## 本番を足す

「値の作り方」で `OPDS_USERNAME` と `OPDS_PASSWORD` を入れる。桁数が 0 のパスワードは put しない。

```bash
printf '%s' "$OPDS_USERNAME" | npx wrangler secret put OPDS_USERNAME
printf '%s' "$OPDS_PASSWORD" | npx wrangler secret put OPDS_PASSWORD
```

登録できたら unset する。

```bash
unset OPDS_USERNAME OPDS_PASSWORD
```

CrossPoint には同じユーザー名とパスワードを HTTP Basic で登録する。入口は README の「Xteink で読む」。

標準入力が端末のときは、`npx wrangler secret put OPDS_PASSWORD` が値のプロンプトになる。プロンプトに貼っても履歴には残らない。上の `printf` は、桁数を見た変数をそのまま渡す。

## 本番を消す

`npx wrangler secret delete` は消す前に確認する。消すと `/opds` は Basic で入れなくなる。

```bash
npx wrangler secret delete OPDS_PASSWORD
npx wrangler secret delete OPDS_USERNAME
```

## 本番を替える

「混ぜない」のとおり、必要なときだけ先にスモークのハッシュを替える。そのあと本番を上書きする。ユーザー名を替えるときも同じ形で `OPDS_USERNAME` を put する。

```bash
printf 'OPDS_PASSWORD: '
read -rs OPDS_PASSWORD
```

```bash
printf '\n'
echo ${#OPDS_PASSWORD}
```

0 なら put しない。

```bash
printf '%s' "$OPDS_PASSWORD" | npx wrangler secret put OPDS_PASSWORD
```

登録できたら unset する。

```bash
unset OPDS_PASSWORD
```

CrossPoint に保存したパスワードも同じ値にする。`read` より後ろを、同じ貼り付けに入れない。

## スモークを足す

Worker のハッシュを先、GitHub Actions の生の値をあと。生の値だけ先だと、次のデプロイスモークは 401 で失敗する。両方空のあいだは skip する。材料は本番の資格情報にしない。

「値の作り方」のランダム生成とハッシュまで進める。ハッシュの桁数が 64 のときだけ続ける。

```bash
printf '%s' "$SMOKE_OPDS_BASIC_SHA256" | npx wrangler secret put SMOKE_OPDS_BASIC_SHA256
printf '%s' "$SMOKE_OPDS_USERNAME" | gh secret set SMOKE_OPDS_USERNAME
printf '%s' "$SMOKE_OPDS_PASSWORD" | gh secret set SMOKE_OPDS_PASSWORD
```

登録できたら unset する。

```bash
unset SMOKE_OPDS_USERNAME SMOKE_OPDS_PASSWORD SMOKE_OPDS_BASIC_SHA256
```

画面から足すときは Settings → Secrets and variables → Actions → Secrets。値はプロンプトに貼る。コマンドには書かない。

## スモークを消す

Worker のハッシュを先に消す。残っていると、GitHub Actions から消したあとも古いパスワードがスモークとして通る。`gh secret delete` は確認しない。

```bash
npx wrangler secret delete SMOKE_OPDS_BASIC_SHA256
gh secret delete SMOKE_OPDS_USERNAME
gh secret delete SMOKE_OPDS_PASSWORD
```

Worker に古い生の名前が残っているときだけ、それも消す。代替としては残さない。

```bash
npx wrangler secret delete SMOKE_OPDS_USERNAME
npx wrangler secret delete SMOKE_OPDS_PASSWORD
```

## スモークを替える

新しいスモーク専用のユーザー名とパスワードで、「スモークを足す」と同じ順にする。`secret put` と `gh secret set` は同じ名前を上書きする。ハッシュと GitHub Actions の生の値は続けて入れ、そのあいだに deploy smoke を走らせない。片方だけ新しいと 401 になる。本番のパスワードは材料にしない。
