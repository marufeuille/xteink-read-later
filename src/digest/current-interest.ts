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

/** Memo words. Particles, spaces, and punctuation separate them. Tokens shorter than 2 characters are dropped. */
export function digestMemoWords(memo: string): readonly string[] {
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

function interestHaystack(title: string, excerpt: string): string {
  return fold(`${title}\n${excerpt}`).replace(/[\s　]+/gu, '')
}

/**
 * How many distinct memo words appear in the title or the excerpt.
 * A judged candidate does not store excerpt text, only `recommend_excerpt_hash`, so selection passes ''.
 */
export function digestMemoWordOverlap(title: string, excerpt: string, memo: string): number {
  const tokens = digestMemoWords(memo)
  if (tokens.length === 0) {
    return 0
  }
  const haystack = interestHaystack(title, excerpt)
  let count = 0
  for (const token of tokens) {
    if (haystack.includes(token)) {
      count += 1
    }
  }
  return count
}
