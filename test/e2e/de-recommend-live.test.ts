import { describe, expect, it } from 'vitest'
import { evaluateDeRecommendation, excerptFromExtractedHtml } from '../../src/recommend/evaluate'
import { parseHttpUrl } from '../../src/types'

const live = process.env.E2E_LIVE === '1'

describe.skipIf(!live)('live DE recommendation', () => {
  it('classifies a Japanese excerpt through real Jev without scoring 0-100', async () => {
    if ((process.env.OPENROUTER_API_KEY ?? '').trim().length === 0) {
      throw new Error('E2E_LIVE=1 requires OPENROUTER_API_KEY')
    }
    const canonicalUrl = parseHttpUrl('https://example.com/ja/workers-cpu')
    if (canonicalUrl === null) {
      throw new Error('url')
    }
    const excerpt = excerptFromExtractedHtml(
      '<article><h1>Cloudflare Workers の CPU 制限</h1><p>本文抽出と EPUB 生成を同時に行うなら Paid プランを前提にする。キューと CPU 時間の制約を実測して決める。</p></article>',
      canonicalUrl,
    )
    const result = await evaluateDeRecommendation(
      {
        title: 'Cloudflare Workers の CPU 制限',
        outlet: 'example.com',
        canonicalUrl,
        excerpt,
      },
      { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' },
    )
    expect(['evaluated', 'low_confidence', 'failed']).toContain(result.status)
    expect(result.grade === null || result.grade === 'recommended' || result.grade === 'related' || result.grade === 'low_priority').toBe(true)
    if (result.status === 'evaluated') {
      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    }
  }, 20_000)
})
