export const SMOKE_PHRASE = '朝の窓辺で赤い鉛筆を六本数えた'
export const SMOKE_PAGE_TITLE = '[smoke] デプロイ確認'
export const DEFAULT_SMOKE_ARTICLE_URL =
  'https://marufeuille.github.io/xteink-read-later/smoke/article.html'
export const DEFAULT_SMOKE_ORIGIN = 'https://xteink-read-later.marufeuille.workers.dev'
export const SMOKE_MAX_WAIT_MS = 5 * 60 * 1000
export const SMOKE_POLL_INTERVAL_MS = 5_000
export const SMOKE_PREFLIGHT_TIMEOUT_MS = 15_000
export const SMOKE_MAX_PAGE_BYTES = 200_000
export const SMOKE_MAX_EPUB_BYTES = 2_000_000
export const SMOKE_MAX_CATALOG_BYTES = 1_000_000
export const SMOKE_MAX_CATALOG_FETCHES = 6

export const SMOKE_SECRET_NAMES = [
  'SMOKE_CLIP_TOKEN',
  'SMOKE_OPDS_USERNAME',
  'SMOKE_OPDS_PASSWORD',
  'SMOKE_SLACK_WEBHOOK_URL',
] as const

export type SmokeSecretName = (typeof SMOKE_SECRET_NAMES)[number]
