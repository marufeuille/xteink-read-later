import { describe, expect, it, vi } from 'vitest'
import { translateArticle } from '../src/translate/openai'
import { OPENAI_CHAT_URL } from '../src/translate/constants'
import { parseHttpUrl, type ExtractedArticle, type HttpUrl } from '../src/types'

function url(value: string): HttpUrl {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function article(overrides: Partial<ExtractedArticle> = {}): ExtractedArticle {
  return {
    title: 'Keep compatibility_date current',
    author: 'Ada Lovelace',
    publishedAt: '2026-04-12T00:00:00.000Z',
    sourceUrl: url('https://example.com/en/compatibility-date'),
    canonicalUrl: url('https://example.com/en/compatibility-date'),
    contentHtml:
      '<h1>Keep compatibility_date current</h1><p>Set it in wrangler.jsonc.</p><pre><code>{"compatibility_date":"2026-09-19"}</code></pre>',
    language: 'non-ja',
    ...overrides,
  }
}

describe('translateArticle', () => {
  it('does not call OpenAI for Japanese articles', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const input = article({
        language: 'ja',
        title: 'Cloudflare Workers の CPU 制限',
        contentHtml: '<p>Paid プランを前提にする。</p><pre><code>npx wrangler dev</code></pre>',
      })
      const result = await translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.value.translated).toBe(false)
      expect(result.value.language).toBe('ja')
      expect(result.value.contentHtml).toContain('npx wrangler dev')
      expect(result.value.title).toBe(input.title)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('translates English HTML and keeps code fences from the model output', async () => {
    const payload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'compatibility_date を最新に保つ',
              contentHtml:
                '<h1>compatibility_date を最新に保つ</h1><p>wrangler.jsonc で指定する。</p><pre><code>{"compatibility_date":"2026-09-19"}</code></pre>',
            }),
          },
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        expect(String(input)).toBe(OPENAI_CHAT_URL)
        return Response.json(payload)
      }),
    )
    try {
      const result = await translateArticle(article(), { OPENAI_API_KEY: 'sk-test' })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.value.translated).toBe(true)
      expect(result.value.language).toBe('ja')
      expect(result.value.title).toBe('compatibility_date を最新に保つ')
      expect(result.value.contentHtml).toContain('{"compatibility_date":"2026-09-19"}')
      expect(result.value.contentHtml).toContain('<pre><code>')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the extracted article when OpenAI fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    try {
      const input = article()
      const result = await translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('translate_failed')
      expect(result.error.extracted).toEqual(input)
      expect(result.error.reason).toContain('500')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
