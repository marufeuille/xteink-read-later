import { parseHttpUrl } from '../types'

export function configuredSmokeArticleUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  return parseHttpUrl(trimmed)
}

export function httpUrlsEqual(left: string, right: string): boolean {
  const actual = parseHttpUrl(left)
  const expected = parseHttpUrl(right)
  return actual !== null && actual === expected
}

export function articleMatchesSmokeUrl(
  article: { readonly sourceUrl: string; readonly canonicalUrl: string },
  smokeUrl: string | undefined,
): boolean {
  const expected = configuredSmokeArticleUrl(smokeUrl)
  if (expected === null) {
    return false
  }
  return httpUrlsEqual(article.sourceUrl, expected) || httpUrlsEqual(article.canonicalUrl, expected)
}
