export type ArticleTitleSources = {
  readonly socialTitle: string | null
  readonly jsonLdHeadline: string | null
  readonly documentTitle: string | null
  readonly heading: string | null
  readonly ogDescription: string | null
}

const X_PROFILE_JA = /^Xユーザーの.+さん$/
const X_STATUS_JA = /^Xユーザーの.+さん\s*[:：]/
const X_PROFILE_EN = /^.+ \(@[A-Za-z0-9_]{1,15}\) on X$/
const X_STATUS_EN = /^.+ on X:\s*["“].+["”]\s*\/\s*X$/

export function normalizeTitleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// X serves the profile as og:title / document title. The article title is the body heading.
export function isXProfileChromeTitle(value: string): boolean {
  const text = normalizeTitleText(value)
  if (text.length === 0) {
    return false
  }
  return X_PROFILE_JA.test(text) || X_STATUS_JA.test(text) || X_PROFILE_EN.test(text) || X_STATUS_EN.test(text)
}

export function firstUsableHeading(headings: readonly string[]): string | null {
  for (const heading of headings) {
    const text = normalizeTitleText(heading)
    if (text.length > 0 && !isXProfileChromeTitle(text)) {
      return text
    }
  }
  return null
}

function present(value: string | null): string | null {
  if (value === null) {
    return null
  }
  const text = normalizeTitleText(value)
  return text.length > 0 ? text : null
}

function usable(value: string | null): string | null {
  const text = present(value)
  if (text === null || isXProfileChromeTitle(text)) {
    return null
  }
  return text
}

function firstUsable(...values: Array<string | null>): string | null {
  for (const value of values) {
    const text = usable(value)
    if (text !== null) {
      return text
    }
  }
  return null
}

export function pickArticleTitle(sources: ArticleTitleSources): string | null {
  const social = present(sources.socialTitle)
  const headline = present(sources.jsonLdHeadline)
  const documentTitle = present(sources.documentTitle)
  const heading = present(sources.heading)
  const description = present(sources.ogDescription)
  const socialChrome = social !== null && isXProfileChromeTitle(social)
  const documentChrome = documentTitle !== null && isXProfileChromeTitle(documentTitle)
  if (socialChrome || (social === null && documentChrome)) {
    return firstUsable(heading, description, headline, documentChrome ? null : documentTitle)
  }
  return firstUsable(social, headline, documentTitle, heading)
}
