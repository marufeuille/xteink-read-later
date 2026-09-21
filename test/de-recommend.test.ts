import { describe, expect, it } from 'vitest'
import { evaluateDeRecommendation } from '../src/recommend/evaluate'
import { parseCandidateRecommendation, recommendBindValues } from '../src/recommend/parse'
import {
  RECOMMEND_MIN_CONFIDENCE,
  RECOMMEND_VERSION,
  evaluatedRecommendation,
  shouldReuseRecommendation,
  toRecommendPublic,
  unevaluatedRecommendation,
} from '../src/recommend/taxonomy'
import { resolveDeRecommendation } from '../src/candidates/recommend'
import { registerCandidate } from '../src/candidates/register'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { err, ok, parseHttpUrl, type EvaluateSystemOne, type FetchPage, type HttpUrl } from '../src/types'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtures = dirname(fileURLToPath(import.meta.url))

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function fetchHtml(pages: Record<string, { html: string }>): FetchPage {
  return async (url) => {
    const page = pages[url]
    if (page === undefined) {
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    }
    return ok({
      requestedUrl: url,
      finalUrl: url,
      contentType: 'text/html',
      html: page.html,
    })
  }
}

const choice = (label: string, confidence: number) => ({
  type: 'choice' as const,
  choice: label,
  confidence,
  probabilities: { [label]: confidence },
})

const noul = (value: number) => ({ type: 'noul' as const, noul: value })

function successfulEvaluate(grade = 'recommended', confidence = 0.92): EvaluateSystemOne {
  return async (request) => {
    expect(request.questions.recommendation?.type).toBe('choice')
    expect(request.questions.de_relevant?.type).toBe('noul')
    const state = request.state as { excerpt: string; title: string }
    expect(state.excerpt.length).toBeGreaterThan(0)
    expect(state.title.length).toBeGreaterThan(0)
    return {
      ok: true,
      value: {
        model: 'jev-1.13.0',
        answers: {
          recommendation: choice(grade, confidence),
          de_relevant: noul(0.91),
          has_concreteness: noul(0.82),
          has_verification: noul(0.2),
        },
        usage: { inputTokens: 410, outputTokens: 20 },
      },
    }
  }
}

describe('evaluateDeRecommendation', () => {
  const input = {
    title: 'Workers CPU',
    outlet: 'example.com',
    canonicalUrl: 'https://example.com/ja/workers-cpu',
    excerpt: 'Paid プランの CPU 時間を前提にする。抽出と EPUB 生成を同時に行う。',
  }

  it('skips Jev when OPENROUTER_API_KEY is unset', async () => {
    const evaluate: EvaluateSystemOne = async () => {
      throw new Error('evaluate should not run')
    }
    const result = await evaluateDeRecommendation(input, { OPENROUTER_API_KEY: '' }, evaluate)
    expect(result.status).toBe('skipped')
    expect(result.grade).toBeNull()
    expect(result.version).toBe(RECOMMEND_VERSION)
  })

  it('stores the grade when confidence clears the gate and keeps reasons as booleans', async () => {
    const result = await evaluateDeRecommendation(input, { OPENROUTER_API_KEY: 'or-test' }, successfulEvaluate())
    expect(result.status).toBe('evaluated')
    if (result.status !== 'evaluated') {
      return
    }
    expect(result.grade).toBe('recommended')
    expect(result.confidence).toBe(0.92)
    expect(result.relevant).toBe(true)
    expect(result.concrete).toBe(true)
    expect(result.verification).toBe(false)
    expect(toRecommendPublic(result)).toEqual({
      status: 'evaluated',
      grade: 'recommended',
      reasons: ['de_relevant', 'has_concreteness'],
      evaluatedAt: result.evaluatedAt,
    })
    expect('confidence' in toRecommendPublic(result)).toBe(false)
  })

  it('hides the grade on low confidence instead of treating it as low priority', async () => {
    const result = await evaluateDeRecommendation(
      input,
      { OPENROUTER_API_KEY: 'or-test' },
      successfulEvaluate('low_priority', RECOMMEND_MIN_CONFIDENCE - 0.2),
    )
    expect(result.status).toBe('low_confidence')
    expect(result.grade).toBeNull()
    if (result.status !== 'low_confidence') {
      return
    }
    expect(result.decidedGrade).toBe('low_priority')
    expect(toRecommendPublic(result).grade).toBeNull()
  })

  it('treats unknown Choice labels as low_confidence', async () => {
    const result = await evaluateDeRecommendation(
      input,
      { OPENROUTER_API_KEY: 'or-test' },
      successfulEvaluate('excellent', 0.99),
    )
    expect(result.status).toBe('low_confidence')
    expect(result.grade).toBeNull()
  })

  it('maps invalid payloads and API failures without calling them low priority', async () => {
    const invalid: EvaluateSystemOne = async () => ({
      ok: true,
      value: {
        model: 'jev-1.13.0',
        answers: {
          recommendation: choice('recommended', 0.9),
        },
        usage: { inputTokens: 10, outputTokens: 1 },
      },
    })
    const invalidResult = await evaluateDeRecommendation(input, { OPENROUTER_API_KEY: 'or-test' }, invalid)
    expect(invalidResult.status).toBe('failed')
    expect(invalidResult.errorCode).toBe('recommend_invalid_payload')
    expect(invalidResult.grade).toBeNull()

    const httpFail: EvaluateSystemOne = async () => ({
      ok: false,
      error: { kind: 'jev_failed', code: 'http', reason: '503' },
    })
    const failed = await evaluateDeRecommendation(input, { OPENROUTER_API_KEY: 'or-test' }, httpFail)
    expect(failed.status).toBe('failed')
    expect(failed.errorCode).toBe('recommend_http')
  })
})

describe('shouldReuseRecommendation', () => {
  it('reuses evaluated results with the same version and excerpt hash', () => {
    const existing = {
      ...unevaluatedRecommendation(),
      status: 'evaluated' as const,
      version: RECOMMEND_VERSION,
      grade: 'related' as const,
      decidedGrade: 'related' as const,
      confidence: 0.8,
      model: 'jev',
      excerptHash: 'abc',
      evaluatedAt: '2026-09-21T00:00:00.000Z',
      relevant: true,
      concrete: false,
      verification: false,
      errorCode: null,
      inputTokens: 1,
      durationMs: 10,
    }
    expect(shouldReuseRecommendation(existing, { excerptHash: 'abc', hasApiKey: true, force: false })).toBe(true)
    expect(shouldReuseRecommendation(existing, { excerptHash: 'abc', hasApiKey: true, force: true })).toBe(false)
    expect(shouldReuseRecommendation(existing, { excerptHash: 'def', hasApiKey: true, force: false })).toBe(false)
  })

  it('retries failed judgments and skipped when a key appears', () => {
    const failed = {
      ...unevaluatedRecommendation(),
      status: 'failed' as const,
      version: RECOMMEND_VERSION,
      excerptHash: 'abc',
      evaluatedAt: '2026-09-21T00:00:00.000Z',
      errorCode: 'recommend_http' as const,
      durationMs: 8,
    }
    expect(shouldReuseRecommendation(failed, { excerptHash: 'abc', hasApiKey: true, force: false })).toBe(false)
    const skipped = {
      ...unevaluatedRecommendation(),
      status: 'skipped' as const,
      version: RECOMMEND_VERSION,
      excerptHash: 'abc',
      evaluatedAt: '2026-09-21T00:00:00.000Z',
      durationMs: 0,
    }
    expect(shouldReuseRecommendation(skipped, { excerptHash: 'abc', hasApiKey: false, force: false })).toBe(true)
    expect(shouldReuseRecommendation(skipped, { excerptHash: 'abc', hasApiKey: true, force: false })).toBe(false)
  })
})

describe('registerCandidate recommendation', () => {
  it('evaluates extracted original text and does not hide the candidate', async () => {
    const store = createMemoryCandidateStore()
    const result = await registerCandidate(mustUrl('https://example.com/ja/workers-cpu'), {
      store,
      fetchPage: fetchHtml({ 'https://example.com/ja/workers-cpu': { html: html('ja-tech.html') } }),
      now: () => new Date('2026-09-21T03:00:00.000Z'),
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluateRecommend: successfulEvaluate(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.candidate.listingState).toBe('listed')
    expect(result.value.candidate.recommendation.status).toBe('evaluated')
    expect(result.value.candidate.recommendation.grade).toBe('recommended')
  })

  it('does not call Jev again for a duplicate with the same excerpt', async () => {
    const store = createMemoryCandidateStore()
    let calls = 0
    const evaluate: EvaluateSystemOne = async (request, deps) => {
      calls += 1
      return successfulEvaluate()(request, deps)
    }
    const deps = {
      store,
      fetchPage: fetchHtml({ 'https://example.com/ja/workers-cpu': { html: html('ja-tech.html') } }),
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluateRecommend: evaluate,
    }
    const first = await registerCandidate(mustUrl('https://example.com/ja/workers-cpu'), deps)
    const second = await registerCandidate(mustUrl('https://example.com/ja/workers-cpu'), deps)
    expect(first.ok && second.ok).toBe(true)
    expect(calls).toBe(1)
    if (!second.ok) {
      return
    }
    expect(second.value.duplicate).toBe(true)
    expect(second.value.candidate.recommendation.status).toBe('evaluated')
  })

  it('marks title-only or fetch failures as insufficient material without calling Jev', async () => {
    const store = createMemoryCandidateStore()
    const evaluate: EvaluateSystemOne = async () => {
      throw new Error('evaluate should not run')
    }
    const short = await registerCandidate(mustUrl('https://example.com/tiny'), {
      store,
      fetchPage: fetchHtml({ 'https://example.com/tiny': { html: html('too-short.html') } }),
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluateRecommend: evaluate,
    })
    expect(short.ok).toBe(true)
    if (!short.ok) {
      return
    }
    expect(short.value.candidate.listingState).toBe('listed')
    expect(short.value.candidate.recommendation.status).toBe('insufficient_material')
    expect(short.value.candidate.recommendation.grade).toBeNull()

    const failed = await registerCandidate(mustUrl('https://missing.example.com/gone'), {
      store,
      fetchPage: fetchHtml({}),
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluateRecommend: evaluate,
    })
    expect(failed.ok).toBe(true)
    if (!failed.ok) {
      return
    }
    expect(failed.value.candidate.listingState).toBe('listed')
    expect(failed.value.candidate.recommendation.status).toBe('insufficient_material')
  })

  it('keeps API failures listed and distinct from low priority', async () => {
    const store = createMemoryCandidateStore()
    const result = await registerCandidate(mustUrl('https://example.com/en/compatibility-date'), {
      store,
      fetchPage: fetchHtml({
        'https://example.com/en/compatibility-date': { html: html('en-tech.html') },
      }),
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluateRecommend: async () => ({
        ok: false,
        error: { kind: 'jev_failed', code: 'timeout', reason: 'deadline' },
      }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.candidate.listingState).toBe('listed')
    expect(result.value.candidate.recommendation.status).toBe('failed')
    expect(result.value.candidate.recommendation.grade).toBeNull()
    expect(result.value.candidate.recommendation.errorCode).toBe('recommend_timeout')
  })

  it('does not call Jev for paywalled articles', async () => {
    const store = createMemoryCandidateStore()
    const evaluate: EvaluateSystemOne = async () => {
      throw new Error('evaluate should not run')
    }
    const result = await registerCandidate(mustUrl('https://paywall.example.com/essay'), {
      store,
      fetchPage: fetchHtml({ 'https://paywall.example.com/essay': { html: html('candidate-paywall.html') } }),
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluateRecommend: evaluate,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.candidate.listingState).toBe('excluded')
    expect(result.value.candidate.recommendation.status).toBe('unevaluated')
  })
})

describe('resolveDeRecommendation budget', () => {
  it('leaves confirmed excerpts unevaluated when the call budget is zero', async () => {
    const resolved = await resolveDeRecommendation({
      existing: unevaluatedRecommendation(),
      extractedHtml: '<p>データ基盤のパイプラインを運用する具体的な手順。</p>'.repeat(8),
      title: 'Pipeline',
      outlet: 'example.com',
      canonicalUrl: mustUrl('https://example.com/p'),
      paywalled: false,
      now: new Date('2026-09-21T03:00:00.000Z'),
      budget: { remainingCalls: 0 },
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluate: successfulEvaluate(),
    })
    expect(resolved.recommendation.status).toBe('unevaluated')
    expect(resolved.reused).toBe(false)
  })

  it('keeps a judged grade when a later fetch has no excerpt', async () => {
    const judged = evaluatedRecommendation({
      grade: 'recommended',
      confidence: 0.9,
      model: 'jev-1.13.0',
      excerptHash: 'abc',
      evaluatedAt: '2026-09-21T03:00:00.000Z',
      relevant: true,
      concrete: true,
      verification: false,
      inputTokens: 10,
      durationMs: 20,
    })
    const resolved = await resolveDeRecommendation({
      existing: judged,
      extractedHtml: null,
      title: 'Pipeline',
      outlet: 'example.com',
      canonicalUrl: mustUrl('https://example.com/p'),
      paywalled: false,
      now: new Date('2026-09-21T04:00:00.000Z'),
      force: true,
      budget: { remainingCalls: 1 },
      jevDeps: { OPENROUTER_API_KEY: 'or-test' },
      evaluate: successfulEvaluate(),
    })
    expect(resolved.recommendation).toEqual(judged)
    expect(resolved.reused).toBe(true)
  })
})

describe('parseCandidateRecommendation', () => {
  it('treats missing columns as unevaluated', () => {
    expect(parseCandidateRecommendation({})).toEqual(unevaluatedRecommendation())
  })

  it('restores the stored criteria version instead of stamping the current one', () => {
    const judged = evaluatedRecommendation({
      grade: 'related',
      confidence: 0.88,
      model: 'jev-1.13.0',
      excerptHash: 'abcabcabcabcabcabcabcabcabcabcab',
      evaluatedAt: '2026-09-21T03:00:00.000Z',
      relevant: true,
      concrete: false,
      verification: false,
      inputTokens: 12,
      durationMs: 30,
      version: RECOMMEND_VERSION,
    })
    const bound = recommendBindValues(judged)
    const parsed = parseCandidateRecommendation({
      recommend_status: bound[0],
      recommend_grade: bound[1],
      recommend_decided_grade: bound[2],
      recommend_version: bound[3],
      recommend_model: bound[4],
      recommend_evaluated_at: bound[5],
      recommend_excerpt_hash: bound[6],
      recommend_confidence: bound[7],
      recommend_relevant: bound[8],
      recommend_concrete: bound[9],
      recommend_verification: bound[10],
      recommend_error_code: bound[11],
      recommend_input_tokens: bound[12],
      recommend_duration_ms: bound[13],
    })
    expect(parsed).toEqual(judged)
    expect(parsed.version).toBe(RECOMMEND_VERSION)
    const stale = { ...judged, version: 'other' as typeof judged.version }
    expect(shouldReuseRecommendation(stale, { excerptHash: judged.excerptHash, hasApiKey: true, force: false })).toBe(
      false,
    )
  })
})
