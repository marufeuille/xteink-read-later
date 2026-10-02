import { describe, expect, it, vi } from 'vitest'
import { translateArticle } from '../src/translate/openai'
import {
  OPENAI_CHAT_URL,
  OPENAI_MAX_INPUT_CHARS,
  OPENAI_MODEL,
  TRANSLATE_CHUNK_MAX_CHARS,
  TRANSLATE_SECTION_RULE,
  TRANSLATE_SYSTEM_PROMPT,
  TRANSLATE_TIMEOUT_MS,
} from '../src/translate/constants'
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
  it('uses gpt-5.6-luna', () => {
    expect(OPENAI_MODEL).toBe('gpt-5.6-luna')
  })

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

  it('keeps nested Japanese emphasis instead of leaking private-use slot markers', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const input = article({
        language: 'ja',
        title: '自己修正ループ',
        contentHtml:
          '<p>これでは、AIを使っているようで、<strong>**人間がボトルネック**</strong>になっています。</p>' +
          '<p>****自己修正ループ****</p>' +
          '<p>しかも今回使うのは、<em><strong>Claude Codeだけ</strong></em>です。</p>',
      })
      const result = await translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.value.contentHtml).toContain('人間がボトルネック')
      expect(result.value.contentHtml).toContain('自己修正ループ')
      expect(result.value.contentHtml).toContain('Claude Codeだけ')
      expect(result.value.contentHtml).not.toContain('\uE000')
      expect(result.value.contentHtml).not.toContain('\uE001')
      expect(result.value.contentHtml).not.toMatch(/\*\?0\?\*/)
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
              content:
                '# compatibility_date を最新に保つ\n\nwrangler.jsonc で指定する。\n\n```\n{"compatibility_date":"2026-09-19"}\n```',
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
      expect(result.value.title).toBe('Keep compatibility_date current')
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
    expect(TRANSLATE_TIMEOUT_MS).toBe(60_000)
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
                  '```json\n{"title":"フェンス付き","content":"本文\\n\\n```\\nok\\n```"}\n```',
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
      expect(result.value.title).toBe('Keep compatibility_date current')
      expect(result.value.contentHtml).toContain('<pre><code>ok</code></pre>')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the extracted article when the model JSON is invalid', async () => {
    const payloads = [
      Response.json({ choices: [{ message: { content: 'not-json' } }] }),
      Response.json({ choices: [{ message: { content: '{"title":"only"}' } }] }),
      Response.json({ choices: [{ message: { content: '{"title":"html-only","contentHtml":"<p>x</p>"}' } }] }),
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

  it('keeps the extracted title when the model title changes', async () => {
    const titles = ['モデル見出しA', 'モデル見出しB']
    for (const modelTitle of titles) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: modelTitle,
                    content: `# ${modelTitle}\n\nnodejs_compat が必要。`,
                  }),
                },
              },
            ],
          }),
        ),
      )
      try {
        const input = article()
        const result = await translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
        expect(result.ok).toBe(true)
        if (!result.ok) {
          return
        }
        expect(result.value.title).toBe(input.title)
        expect(result.value.title).not.toBe(modelTitle)
        expect(result.value.contentHtml).toContain('nodejs_compat')
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })

  it('sends compact markdown without tag soup to OpenAI', async () => {
    const payload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'compatibility_date を最新に保つ',
              content: '# compatibility_date を最新に保つ\n\nwrangler.jsonc で指定する。',
            }),
          },
        },
      ],
    }
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : ''
      const body = JSON.parse(raw) as {
        model?: string
        temperature?: unknown
        reasoning_effort?: string
        max_completion_tokens?: number
        response_format?: unknown
        messages: Array<{ role: string; content: string }>
      }
      expect(body.model).toBe(OPENAI_MODEL)
      expect(body.temperature).toBeUndefined()
      expect(body.reasoning_effort).toBe('none')
      expect(body.max_completion_tokens).toBe(16_000)
      expect(body.response_format).toEqual({ type: 'json_object' })
      const user = JSON.parse(body.messages[1]?.content ?? '{}') as {
        content?: string
        contentHtml?: string
      }
      expect(user.contentHtml).toBeUndefined()
      expect(user).not.toHaveProperty('part')
      expect(body.messages[0]?.content).toBe(TRANSLATE_SYSTEM_PROMPT)
      expect(user.content).toContain('# Keep compatibility_date current')
      expect(user.content).toContain('nodejs_compat')
      expect(user.content).not.toMatch(/<script|<nav|<iframe|<svg|<form/i)
      expect(user.content).not.toContain('window.ads')
      expect(user.content).not.toContain('Sponsored advertisement')
      return Response.json(payload)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const soup =
        '<script>window.ads="banner"</script><nav>Home</nav><iframe src="https://ads.example"></iframe><svg></svg><form><input name="x"></form><div class="advertisement">Sponsored advertisement</div><h1>Keep compatibility_date current</h1><p>Node.js built-ins need the nodejs_compat compatibility flag.</p>'
      const result = await translateArticle(article({ contentHtml: soup }), {
        OPENAI_API_KEY: 'sk-test',
      })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(result.ok).toBe(true)
    } finally {
      vi.unstubAllGlobals()
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

  it('translates a long article in sections that each stay inside the timeout budget', async () => {
    const calls: Array<{ content: string; part: { index: number; total: number }; system: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const raw = typeof init?.body === 'string' ? init.body : ''
        const body = JSON.parse(raw) as { messages: Array<{ content: string }> }
        const system = body.messages[0]?.content ?? ''
        const user = JSON.parse(body.messages[1]?.content ?? '{}') as {
          content?: string
          part?: { index: number; total: number }
        }
        const content = user.content ?? ''
        const part = user.part
        if (part === undefined) {
          throw new Error('expected part')
        }
        calls.push({ content, part, system })
        expect(content.length).toBeLessThanOrEqual(TRANSLATE_CHUNK_MAX_CHARS)
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: '見出し',
                  content: content.includes('KEEP_FENCE_TOKEN')
                    ? `区間${part.index}\n\n\`\`\`\nKEEP_FENCE_TOKEN\n\`\`\``
                    : `区間${part.index}\n\n訳した本文`,
                }),
              },
            },
          ],
        })
      }),
    )
    try {
      const sentence = 'Review every generated line before it ships. '
      const paragraph = `<p>${sentence.repeat(80)}</p>`
      const result = await translateArticle(
        article({
          title: 'The code nobody reads',
          contentHtml: `<h1>The code nobody reads</h1>${paragraph.repeat(3)}<pre><code>KEEP_FENCE_TOKEN</code></pre>${paragraph.repeat(3)}`,
        }),
        { OPENAI_API_KEY: 'sk-test' },
      )
      expect(calls.length).toBeGreaterThan(1)
      expect(calls.map((call) => call.part.index)).toEqual(calls.map((_, index) => index + 1))
      expect(calls.every((call) => call.part.total === calls.length)).toBe(true)
      expect(calls.every((call) => call.system.endsWith(TRANSLATE_SECTION_RULE))).toBe(true)
      const fenceCalls = calls.filter((call) => call.content.includes('KEEP_FENCE_TOKEN'))
      expect(fenceCalls).toHaveLength(1)
      expect(fenceCalls[0]?.content).toMatch(/```[\s\S]*KEEP_FENCE_TOKEN[\s\S]*```/)
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      const first = result.value.contentHtml.indexOf('区間1')
      const second = result.value.contentHtml.indexOf('区間2')
      expect(first).toBeGreaterThanOrEqual(0)
      expect(second).toBeGreaterThan(first)
      expect(result.value.contentHtml).toContain('KEEP_FENCE_TOKEN')
      expect(result.value.contentHtml).toContain('<pre><code>')
      expect(result.value.title).toBe('The code nobody reads')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('names the section when a later chunk times out', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(
            Response.json({
              choices: [
                {
                  message: {
                    content: JSON.stringify({ title: '見出し', content: '最初の区間' }),
                  },
                },
              ],
            }),
          )
        }
        return new Promise<Response>(() => {})
      }),
    )
    try {
      const sentence = 'Review every generated line before it ships. '
      const pending = translateArticle(
        article({ contentHtml: `<p>${sentence.repeat(400)}</p>` }),
        { OPENAI_API_KEY: 'sk-test' },
      )
      await vi.advanceTimersByTimeAsync(TRANSLATE_TIMEOUT_MS)
      const result = await pending
      expect(calls).toBe(2)
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.kind).toBe('translate_failed')
      expect(result.error.reason).toMatch(/^OpenAI request timed out \(section 2 of [0-9]+\)$/)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('stops at the first failing section and does not call OpenAI again', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return new Response('nope', { status: 500 })
      }),
    )
    try {
      const sentence = 'Review every generated line before it ships. '
      const input = article({ contentHtml: `<p>${sentence.repeat(400)}</p>` })
      const result = await translateArticle(input, { OPENAI_API_KEY: 'sk-test' })
      expect(calls).toBe(1)
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.extracted).toEqual(input)
      expect(result.error.reason).toMatch(/^OpenAI HTTP 500 \(section 1 of [0-9]+\)$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not call OpenAI for a long Japanese article', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await translateArticle(
        article({
          language: 'ja',
          title: '長い日本語',
          contentHtml: `<p>${'これは日本語の本文です。'.repeat(800)}</p>`,
        }),
        { OPENAI_API_KEY: 'sk-test' },
      )
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.value.translated).toBe(false)
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
