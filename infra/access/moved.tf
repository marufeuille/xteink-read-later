# R2 の state は Bypass アプリを digest_send_bypass というアドレスで持っている。
# 設定のリソース名は digest_send。このブロックが無いと plan は削除して作り直す。
# apply は state のアドレスだけを移す。Cloudflare のアプリは作り直さない。
# 移したあとも残す。古いアドレスが state に無いときは何もしない。
# ポリシー cloudflare_zero_trust_access_policy.digest_send_bypass は移さない。
moved {
  from = cloudflare_zero_trust_access_application.digest_send_bypass
  to   = cloudflare_zero_trust_access_application.digest_send
}
