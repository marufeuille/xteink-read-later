/**
 * Short note of the current digest interest.
 * Replace the text, or set it to '' when it goes stale.
 * An empty note does not change within-bucket order.
 */
export const DIGEST_CURRENT_INTEREST_MEMO = 'データ基盤のオントロジー'

const MEMO_SPLIT = /[\s　、。，．,.・/／|｜:：;；()（）「」『』【】\[\]"'“”`~〜!！?？+\-_=のとをにはがでへや]+/u

function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function interestTokens(memo: string): readonly string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const part of fold(memo).split(MEMO_SPLIT)) {
    if (part.length < 2 || seen.has(part)) {
      continue
    }
    seen.add(part)
    tokens.push(part)
  }
  return tokens
}

function interestHaystack(title: string): string {
  return fold(title).replace(/[\s　]+/gu, '')
}

/** 1 when every content word of the memo appears in the title. An empty memo is 0. */
export function digestCurrentInterestRank(title: string, memo: string): 0 | 1 {
  const tokens = interestTokens(memo)
  if (tokens.length === 0) {
    return 0
  }
  const haystack = interestHaystack(title)
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0
}
