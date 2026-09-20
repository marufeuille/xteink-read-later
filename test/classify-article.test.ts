import { describe, expect, it } from 'vitest'
import { classifyArticle } from '../src/classify/article'
import { CLASSIFICATION_VERSION, CLASSIFY_MAX_EXCERPT_CHARS, CLASSIFY_MIN_CONFIDENCE } from '../src/classify/taxonomy'
import { parseHttpUrl, type EvaluateSystemOne, type TranslatedArticle } from '../src/types'

function url(value: string) {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function article(): TranslatedArticle {
  return {
    title: 'Cloudflare Workers の CPU 制限',
    author: null,
    publishedAt: null,
    sourceUrl: url('https://example.com/ja/workers-cpu'),
    canonicalUrl: url('https://example.com/ja/workers-cpu'),
    contentHtml: '<p>Paid プランの CPU 時間を前提にする。</p>',
    language: 'ja',
    translated: false,
  }
}

const choice = (label: string, confidence: number) => ({
  type: 'choice' as const,
  choice: label,
  confidence,
  probabilities: { [label]: confidence },
})

describe('classifyArticle', () => {
  it('skips Jev when OPENROUTER_API_KEY is unset', async () => {
    const evaluate: EvaluateSystemOne = async () => {
      throw new Error('evaluate should not run')
    }
    const result = await classifyArticle(article(), { OPENROUTER_API_KEY: '' }, evaluate)
    expect(result).toMatchObject({
      version: CLASSIFICATION_VERSION,
      status: 'skipped',
      topic: 'uncategorized',
      kind: 'uncategorized',
      decidedTopic: null,
      model: null,
      errorCode: null,
    })
  })

  it('stores the decided labels when both confidences clear the threshold', async () => {
    const evaluate: EvaluateSystemOne = async (request) => {
      expect(request.questions.topic?.type).toBe('choice')
      expect(request.questions.kind?.type).toBe('choice')
      const state = request.state as { title: string; excerpt: string }
      expect(state.title).toContain('CPU')
      expect(state.excerpt).toContain('CPU 時間')
      return {
        ok: true,
        value: {
          model: 'jev-1.13.0',
          answers: {
            topic: choice('tech', 0.92),
            kind: choice('explainer', 0.88),
          },
          usage: { inputTokens: 380, outputTokens: 18 },
        },
      }
    }
    const result = await classifyArticle(article(), { OPENROUTER_API_KEY: 'or-test' }, evaluate)
    expect(result.status).toBe('classified')
    expect(result.topic).toBe('tech')
    expect(result.kind).toBe('explainer')
    expect(result.decidedTopic).toBe('tech')
    expect(result.decidedKind).toBe('explainer')
    expect(result.model).toBe('jev-1.13.0')
    expect(result.inputTokens).toBe(380)
    expect(result.topicConfidence).toBe(0.92)
    expect(result.errorCode).toBeNull()
  })

  it('keeps the decided labels but shelves uncategorized below the confidence gate', async () => {
    const evaluate: EvaluateSystemOne = async () => ({
      ok: true,
      value: {
        model: 'jev-1.13.0',
        answers: {
          topic: choice('society', CLASSIFY_MIN_CONFIDENCE - 0.2),
          kind: choice('news', 0.95),
        },
        usage: { inputTokens: 200, outputTokens: 12 },
      },
    })
    const result = await classifyArticle(article(), { OPENROUTER_API_KEY: 'or-test' }, evaluate)
    expect(result.status).toBe('low_confidence')
    expect(result.topic).toBe('uncategorized')
    expect(result.kind).toBe('news')
    expect(result.decidedTopic).toBe('society')
    expect(result.decidedKind).toBe('news')
    expect(result.errorCode).toBeNull()
  })

  it('treats unknown Choice labels as low_confidence uncategorized', async () => {
    const evaluate: EvaluateSystemOne = async (request) => {
      expect(request.questions.topic?.type).toBe('choice')
      if (request.questions.topic?.type === 'choice') {
        expect(request.questions.topic.instructions).toContain('criteria')
      }
      return {
        ok: true,
        value: {
          model: 'jev-1.13.0',
          answers: {
            topic: choice('gadgets', 0.99),
            kind: choice('thread', 0.98),
          },
          usage: { inputTokens: 180, outputTokens: 10 },
        },
      }
    }
    const result = await classifyArticle(article(), { OPENROUTER_API_KEY: 'or-test' }, evaluate)
    expect(result.status).toBe('low_confidence')
    expect(result.topic).toBe('uncategorized')
    expect(result.kind).toBe('uncategorized')
    expect(result.decidedTopic).toBeNull()
    expect(result.decidedKind).toBeNull()
    expect(result.errorCode).toBeNull()
  })

  it('caps the excerpt sent to Jev', async () => {
    const evaluate: EvaluateSystemOne = async (request) => {
      const state = request.state as { excerpt: string }
      expect(state.excerpt.length).toBeLessThanOrEqual(CLASSIFY_MAX_EXCERPT_CHARS)
      return {
        ok: true,
        value: {
          model: 'jev-1.13.0',
          answers: {
            topic: choice('tech', 0.9),
            kind: choice('explainer', 0.9),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      }
    }
    const result = await classifyArticle(
      { ...article(), contentHtml: `<p>${'あ'.repeat(20_000)}</p>` },
      { OPENROUTER_API_KEY: 'or-test' },
      evaluate,
    )
    expect(result.status).toBe('classified')
  })

  it('falls back to uncategorized when Jev fails', async () => {
    const evaluate: EvaluateSystemOne = async () => ({
      ok: false,
      error: { kind: 'jev_failed', code: 'http', reason: 'OpenRouter HTTP 529' },
    })
    const result = await classifyArticle(article(), { OPENROUTER_API_KEY: 'or-test' }, evaluate)
    expect(result.status).toBe('failed')
    expect(result.topic).toBe('uncategorized')
    expect(result.kind).toBe('uncategorized')
    expect(result.decidedTopic).toBeNull()
    expect(result.errorCode).toBe('classify_http')
  })
})
