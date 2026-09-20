import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BAKEOFF_MODELS, runBakeoffModel } from '../src/translate/bakeoff-run'
import { htmlToMarkdown } from '../src/extract/sanitize-html'
import { BAKEOFF_ARTICLES } from '../src/translate/bakeoff-corpus'
import { parseHttpUrl } from '../src/types'

describe('translate bakeoff corpus', () => {
  it('pins four English tech articles with code, headings, and a 2026 proper-noun piece', () => {
    expect(BAKEOFF_ARTICLES.map((article) => article.id)).toEqual([
      'workers-compat',
      'durable-objects',
      'hedging-prose',
      'jp-llm-wave',
    ])
    expect(BAKEOFF_ARTICLES.every((article) => article.hasCode && article.hasHeadings)).toBe(true)
    expect(BAKEOFF_ARTICLES.some((article) => article.nouns2026.length > 0)).toBe(true)
  })

  it('keeps code fences, headings, links, and untranslated tokens after Markdown conversion', () => {
    for (const article of BAKEOFF_ARTICLES) {
      const html = readFileSync(article.file, 'utf8')
      const base = parseHttpUrl(`https://example.com/bakeoff/${article.id}`)
      expect(base).not.toBeNull()
      if (base === null) {
        return
      }
      const markdown = htmlToMarkdown(html, base)
      expect(markdown).toMatch(/^# /m)
      expect(markdown).toContain('```')
      expect(markdown).toMatch(/\[[^\]]+\]\(https?:\/\/[^)]+\)/)
      for (const token of article.keepTokens) {
        expect(markdown, `${article.id} missing ${token}`).toContain(token)
      }
      for (const token of article.nouns2026) {
        expect(markdown).toContain(token)
      }
    }
  })

  it('records a skipped run when bakeoff API keys are missing', async () => {
    const article = BAKEOFF_ARTICLES[0]
    const openai = BAKEOFF_MODELS.find((model) => model.id === 'gpt-4o-mini')
    const plamo = BAKEOFF_MODELS.find((model) => model.id === 'plamo-3.0-prime')
    expect(article).toBeDefined()
    expect(openai).toBeDefined()
    expect(plamo).toBeDefined()
    if (article === undefined || openai === undefined || plamo === undefined) {
      return
    }
    const missingOpenAi = await runBakeoffModel(openai, article, { openai: null, plamo: null })
    expect(missingOpenAi.ok).toBe(false)
    expect(missingOpenAi.reason).toContain('OPENAI_API_KEY')
    const missingPlamo = await runBakeoffModel(plamo, article, { openai: null, plamo: null })
    expect(missingPlamo.ok).toBe(false)
    expect(missingPlamo.reason).toContain('PLAMO_API_KEY')
  })
})
