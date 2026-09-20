export type BakeoffArticle = {
  readonly id: string
  readonly file: string
  readonly title: string
  readonly keepTokens: readonly string[]
  readonly hasCode: true
  readonly hasHeadings: true
  readonly nouns2026: readonly string[]
}

export const BAKEOFF_ARTICLES: readonly BakeoffArticle[] = [
  {
    id: 'workers-compat',
    file: 'test/fixtures/translate-bakeoff/workers-compat.html',
    title: 'Keep compatibility_date current',
    keepTokens: ['compatibility_date', 'wrangler.jsonc', 'nodejs_compat', 'cpu_ms', '2026-09-19'],
    hasCode: true,
    hasHeadings: true,
    nouns2026: ['2026-09-19'],
  },
  {
    id: 'durable-objects',
    file: 'test/fixtures/translate-bakeoff/durable-objects.html',
    title: 'Durable Objects SQLite is the default storage now',
    keepTokens: ['Durable Object', 'POST /clip', 'gpt-4.1-mini', 'Workers AI', 'GPT-5.6'],
    hasCode: true,
    hasHeadings: true,
    nouns2026: ['gpt-4.1-mini', 'GPT-5.6'],
  },
  {
    id: 'hedging-prose',
    file: 'test/fixtures/translate-bakeoff/hedging-prose.html',
    title: 'When a translation sounds almost right',
    keepTokens: ['npx wrangler deploy', 'gpt-4o-mini', 'compatibility_date', 'test:e2e'],
    hasCode: true,
    hasHeadings: true,
    nouns2026: [],
  },
  {
    id: 'jp-llm-wave',
    file: 'test/fixtures/translate-bakeoff/jp-llm-wave.html',
    title: 'Japanese LLMs in 2026: PLaMo 3.0 Prime and Sakana Namazu',
    keepTokens: [
      'PLaMo 3.0 Prime',
      'Sakana Namazu',
      'plamo-3.0-prime',
      'Kimi K2.6',
      'gpt-4.1-mini',
    ],
    hasCode: true,
    hasHeadings: true,
    nouns2026: ['PLaMo 3.0 Prime', 'Sakana Namazu', 'Kimi K2.6'],
  },
]
