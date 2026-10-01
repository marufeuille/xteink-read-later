# Cloudflare Access（self-hosted、アプリは2つ）。2026-10-01 の実体。
# MAR-142 は Masahiro 承認のうえで本番へ適用済み。
# /books を Allow に足した。/digest/* は外した（send をワイルドカードで覆わない）。
# /digest は配下を継承するので、/digest/send は別アプリの Bypass が要る。
# Team は marufeuille。state は R2。PR で plan し、main へのマージで apply する。
# この 4 リソースの create / destroy / replace は import 漏れか作り直し。マージしない。
#
# import 用 ID（リソースの id 属性には書かない。state が import で持つ）:
#   account              ee3ee1637004c64111483d968da0f5b1
#   application (Allow)  00a3a478-9f02-4f1e-b3b4-157bf735f9d4
#   policy (家族only)    b42cf29d-d046-45a6-a6fb-4d6e9d36eb56
#   application (Bypass) 197e967e-d9ef-44c8-8de6-65a9db82fe33
#   policy (digest/send) a45dd0ec-3827-4332-a0f1-eca7cdf64000
#
# 手順は docs/access-as-code.md。

locals {
  hostname = "xteink-read-later.marufeuille.workers.dev"

  # ダッシュボードの並びのまま。並べ替えない。
  # /digest/* は無い。ワイルドカードだと /digest/send まで Allow になる。
  protected_paths = [
    "/candidates",
    "/candidates/",
    "/candidates/*",
    "/sources",
    "/sources/",
    "/sources/*",
    "/clip/web",
    "/clip/web/",
    "/clip/web/*",
    "/digest",
    "/digest/",
    "/clip/recent",
    "/clip/recent/",
    "/books",
    "/books/",
    "/books/*",
  ]

  # 親 /digest の継承を上書きする。この2つだけ。
  digest_send_paths = [
    "/digest/send",
    "/digest/send/",
  ]
}

resource "cloudflare_zero_trust_access_policy" "family" {
  account_id = var.account_id
  name       = "家族only"
  decision   = "allow"

  include = [
    { email = { email = "marufeuille@gmail.com" } },
    { email = { email = "mc.cky.ns0226@gmail.com" } },
  ]

  # ログインは Google。IdP の UUID は 2026-09-30 の読み取りに無い。
  # require を設定に書かず ignore し、空の設定で既存の Require を消さない。
  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      approval_groups,
      approval_required,
      connection_rules,
      exclude,
      isolation_required,
      purpose_justification_prompt,
      purpose_justification_required,
      require,
      session_duration,
    ]
  }
}

resource "cloudflare_zero_trust_access_application" "xteink_read_later" {
  account_id = var.account_id
  type       = "self_hosted"
  name       = "${local.hostname}/candidates"
  domain     = "${local.hostname}/candidates"

  # self_hosted_domains は 2025-11-21 で非推奨。destinations を使う。
  destinations = [
    for path in local.protected_paths : {
      type = "public"
      uri  = "${local.hostname}${path}"
    }
  ]

  # 再利用ポリシーは id と precedence だけ。ルールは family 側。
  policies = [{
    id         = cloudflare_zero_trust_access_policy.family.id
    precedence = var.policy_precedence
  }]

  # 読み取りに無かった項目。未設定のまま apply すると実体を null に戻し得るので無視する。
  # パス・名前・ドメイン・ポリシーの付き方は無視しない。
  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      allowed_idps,
      app_launcher_logo_url,
      app_launcher_visible,
      auto_redirect_to_identity,
      bg_color,
      cors_headers,
      custom_deny_message,
      custom_deny_url,
      custom_non_identity_deny_url,
      custom_pages,
      enable_binding_cookie,
      footer_links,
      header_bg_color,
      http_only_cookie_attribute,
      landing_page_design,
      logo_url,
      options_preflight_bypass,
      path_cookie_attribute,
      same_site_cookie_attribute,
      self_hosted_domains, # 非推奨。validate が警告する。空に戻さないため残す
      service_auth_401_redirect,
      session_duration,
      skip_app_launcher_login_page,
      skip_interstitial,
      tags,
    ]
  }
}

resource "cloudflare_zero_trust_access_policy" "digest_send_bypass" {
  account_id = var.account_id
  name       = "digest/send Bypass"
  decision   = "bypass"

  # everyone。Google の Require は付けない。
  include = [
    { everyone = {} },
  ]

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      approval_groups,
      approval_required,
      connection_rules,
      exclude,
      isolation_required,
      purpose_justification_prompt,
      purpose_justification_required,
      require,
      session_duration,
    ]
  }
}

resource "cloudflare_zero_trust_access_application" "digest_send" {
  account_id = var.account_id
  type       = "self_hosted"
  name       = "${local.hostname}/digest/send"
  domain     = "${local.hostname}/digest/send"

  destinations = [
    for path in local.digest_send_paths : {
      type = "public"
      uri  = "${local.hostname}${path}"
    }
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.digest_send_bypass.id
    precedence = var.policy_precedence
  }]

  # 本体アプリと同じ。未設定のまま apply すると実体を null に戻し得る。
  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      allowed_idps,
      app_launcher_logo_url,
      app_launcher_visible,
      auto_redirect_to_identity,
      bg_color,
      cors_headers,
      custom_deny_message,
      custom_deny_url,
      custom_non_identity_deny_url,
      custom_pages,
      enable_binding_cookie,
      footer_links,
      header_bg_color,
      http_only_cookie_attribute,
      landing_page_design,
      logo_url,
      options_preflight_bypass,
      path_cookie_attribute,
      same_site_cookie_attribute,
      self_hosted_domains, # 非推奨。validate が警告する。空に戻さないため残す
      service_auth_401_redirect,
      session_duration,
      skip_app_launcher_login_page,
      skip_interstitial,
      tags,
    ]
  }
}
