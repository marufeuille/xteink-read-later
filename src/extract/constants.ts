export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export const MAX_HTML_BYTES = 1_500_000
export const FETCH_TIMEOUT_MS = 20_000
export const MIN_CONTENT_CHARS = 80

// Omit `pre` so nested <code>/<span> stay elements. Default node-html-parser
// treats pre as a text node and later escapeText turns tags into visible text.
export const PARSE_HTML_OPTIONS = {
  blockTextElements: {
    script: true,
    noscript: true,
    style: true,
  },
} as const

export const NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'nav',
  'footer',
  'aside',
  'template',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
].join(',')

export const CONTENT_SELECTORS = [
  'article',
  '[itemprop="articleBody"]',
  '.post-content',
  '.entry-content',
  '.article-body',
  '.post-body',
  '.story-body',
  'main article',
  '[role="main"]',
  'main',
  '#content',
] as const
