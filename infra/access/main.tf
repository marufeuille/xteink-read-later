# Cloudflare Access（self-hosted、アプリは1つ）。2026-09-30 JST の実体。
# Team は marufeuille。import してから plan する。この骨格では apply しない。
#
# import 用 ID（リソースの id 属性には書かない。state が import で持つ）:
#   account      ee3ee1637004c64111483d968da0f5b1
#   application  00a3a478-9f02-4f1e-b3b4-157bf735f9d4
#   policy       b42cf29d-d046-45a6-a6fb-4d6e9d36eb56
#
# 手順は docs/access-as-code.md。

locals {
  hostname = "xteink-read-later.marufeuille.workers.dev"

  # ダッシュボードの並びのまま。並べ替えない。
  # /books は実体に無い。足さない。
  protected_paths = [
    # フェーズ1で編集してよい
    "/candidates",
    "/candidates/",
    "/candidates/*",
    # フェーズ1では変えない（state に残し、plan を空に保つ）
    "/sources",
    "/sources/",
    "/sources/*",
    # フェーズ1で編集してよい
    "/clip/web",
    "/clip/web/",
    "/clip/web/*",
    # フェーズ1では変えない
    "/digest",
    "/digest/",
    "/digest/*",
    # フェーズ1で編集してよい。ワイルドカードは無い
    "/clip/recent",
    "/clip/recent/",
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
