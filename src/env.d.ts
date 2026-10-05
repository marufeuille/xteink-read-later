declare namespace Cloudflare {
  interface Env {
    OPENAI_API_KEY: string
    OPENROUTER_API_KEY: string
    CLIP_TOKEN: string
    OPDS_USERNAME: string
    OPDS_PASSWORD: string
    SMOKE_CLIP_TOKEN_SHA256: string
    SMOKE_OPDS_BASIC_SHA256: string
    SMOKE_ARTICLE_URL: string
    PUBLIC_ORIGIN: string
    CRONITOR_API_KEY: string
    CRONITOR_FEED_COLLECT_MONITOR_KEY: string
    CRONITOR_CLIP_MONITOR_KEY: string
    CRONITOR_DAILY_DIGEST_MONITOR_KEY: string
  }
}
