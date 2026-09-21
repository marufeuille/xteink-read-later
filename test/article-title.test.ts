import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractCandidateMetadata } from '../src/candidates/metadata'
import { isXProfileChromeTitle, pickArticleTitle } from '../src/extract/article-title'
import { parseHttpUrl } from '../src/types'

const ARTICLE_TITLE = 'Jev Engineering: Full 10-Step Roadmap to Set Up and Use a New Brain for AI (from scratch)'
const PROFILE_OG = 'Xユーザーのcodila（@0xCodila）さん'
const PROFILE_DOCUMENT = 'Xユーザーのcodilaさん: 「Jev is the "Internet" moment for the AI industry」 / X'

describe('isXProfileChromeTitle', () => {
  it('matches Japanese profile and status chrome', () => {
    expect(isXProfileChromeTitle(PROFILE_OG)).toBe(true)
    expect(isXProfileChromeTitle(`  ${PROFILE_DOCUMENT}\n`)).toBe(true)
    expect(isXProfileChromeTitle('Xユーザーの増加')).toBe(false)
    expect(isXProfileChromeTitle('石井さんのメモ')).toBe(false)
  })

  it('matches English profile and status chrome', () => {
    expect(isXProfileChromeTitle('codila (@0xCodila) on X')).toBe(true)
    expect(isXProfileChromeTitle('codila on X: "Jev is the Internet moment" / X')).toBe(true)
    expect(isXProfileChromeTitle('Notes on X and privacy')).toBe(false)
  })
})

describe('pickArticleTitle', () => {
  it('drops X profile chrome and keeps the body heading', () => {
    expect(
      pickArticleTitle({
        socialTitle: PROFILE_OG,
        jsonLdHeadline: null,
        documentTitle: PROFILE_DOCUMENT,
        heading: `\n  ${ARTICLE_TITLE}\n`,
        ogDescription: ARTICLE_TITLE,
      }),
    ).toBe(ARTICLE_TITLE)
  })

  it('uses og:description when the body heading is missing or also profile chrome', () => {
    expect(
      pickArticleTitle({
        socialTitle: PROFILE_OG,
        jsonLdHeadline: null,
        documentTitle: PROFILE_DOCUMENT,
        heading: PROFILE_OG,
        ogDescription: ARTICLE_TITLE,
      }),
    ).toBe(ARTICLE_TITLE)
  })

  it('does not fall back to a profile title when no article title exists', () => {
    expect(
      pickArticleTitle({
        socialTitle: PROFILE_OG,
        jsonLdHeadline: null,
        documentTitle: PROFILE_DOCUMENT,
        heading: null,
        ogDescription: null,
      }),
    ).toBeNull()
  })

  it('keeps a normal og:title ahead of a different heading and description', () => {
    expect(
      pickArticleTitle({
        socialTitle: 'Cloudflare Workers の CPU 制限',
        jsonLdHeadline: null,
        documentTitle: 'サイト名 | Cloudflare Workers の CPU 制限',
        heading: '別の見出し',
        ogDescription: '本文の要約',
      }),
    ).toBe('Cloudflare Workers の CPU 制限')
  })

  it('drops an English profile title and keeps the body heading', () => {
    expect(
      pickArticleTitle({
        socialTitle: 'codila (@0xCodila) on X',
        jsonLdHeadline: null,
        documentTitle: 'codila on X: "Jev is the Internet moment" / X',
        heading: ARTICLE_TITLE,
        ogDescription: 'tweet text',
      }),
    ).toBe(ARTICLE_TITLE)
  })
})

describe('extractCandidateMetadata X titles', () => {
  it('stores the article heading instead of the profile name', () => {
    const url = parseHttpUrl('https://x.com/0xCodila/status/2100984487802708306')
    if (url === null) {
      throw new Error('fixture url')
    }
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'x-article-ja-ui.html'), 'utf8')
    const metadata = extractCandidateMetadata({
      requestedUrl: url,
      finalUrl: url,
      contentType: 'text/html',
      html,
    })
    expect(metadata.title).toBe(ARTICLE_TITLE)
  })
})
