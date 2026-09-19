import { describe, expect, it, vi } from 'vitest'
import { translateArticle } from '../src/translate/openai'
import { OPENAI_CHAT_URL, OPENAI_MAX_INPUT_CHARS, TRANSLATE_TIMEOUT_MS } from '../src/translate/constants'
import { parseHttpUrl, type ExtractedArticle, type HttpUrl, type TranslateDeps } from '../src/types'

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

  it('fails with the extracted article when OPENAI_API_KEY is missing', async () => {
    const input = article()
    for (const deps of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: '   ' }] as TranslateDeps[]) {
      const result = await translateArticle(input, deps)
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('translate_failed')
      expect(result.error.extracted).toEqual(input)
      expect(result.error.reason).toContain('OPENAI_API_KEY')
    }
  })

  it('times out hanging OpenAI fetch and body reads', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    try {
      const input = article()
      const pending = translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
      await vi.advanceTimersByTimeAsync(TRANSLATE_TIMEOUT_MS)
      const result = await pending
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('translate_failed')
      expect(result.error.extracted).toEqual(input)
      expect(result.error.reason).toContain('timed out')
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('times out when the OpenAI response body never arrives', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start() {
                // Never enqueue or close; the body hang must be bounded.
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    try {
      const pending = translateArticle(article(), { OPENAI_API_KEY: 'sk-test' })
      await vi.advanceTimersByTimeAsync(TRANSLATE_TIMEOUT_MS)
      const result = await pending
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.reason).toContain('timed out')
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
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

  it('accepts JSON wrapped in markdown fences', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content:
                  '```json\n{"title":"フェンス付き","contentHtml":"<p>本文</p><pre><code>ok</code></pre>"}\n```',
              },
            },
          ],
        }),
      ),
    )
    try {
      const result = await translateArticle(article(), { OPENAI_API_KEY: 'sk-test' })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.value.title).toBe('フェンス付き')
      expect(result.value.contentHtml).toContain('<pre><code>ok</code></pre>')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the extracted article when the model JSON is invalid', async () => {
    const payloads = [
      Response.json({ choices: [{ message: { content: 'not-json' } }] }),
      Response.json({ choices: [{ message: { content: '{"title":"only"}' } }] }),
      Response.json({ choices: [{ message: { content: '{"title":"","contentHtml":"<p>x</p>"}' } }] }),
      Response.json({ choices: [] }),
    ]
    for (const payload of payloads) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => payload.clone()),
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
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })

  it('does not call OpenAI when extracted HTML exceeds the size limit', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const input = article({ contentHtml: `<p>${'a'.repeat(OPENAI_MAX_INPUT_CHARS + 1)}</p>` })
      const result = await translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.extracted).toEqual(input)
      expect(result.error.reason).toContain('size limit')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the extracted article when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )
    try {
      const input = article()
      const result = await translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.extracted).toEqual(input)
      expect(result.error.reason).toContain('network down')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
