import { describe, expect, it, vi } from 'vitest'
import { evaluateSystemOne } from '../src/jev/client'
import {
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  OPENROUTER_DECISIONS_URL,
} from '../src/jev/constants'
import type { JevDeps, SystemOneRequest } from '../src/types'

const request: SystemOneRequest = {
  state: { title: 'Workers CPU limits' },
  questions: {
    topic: {
      type: 'choice',
      instructions: 'Pick a topic',
      criteria: { tech: 'Software', science: 'Science' },
    },
    urgent: {
      type: 'noul',
      instructions: 'Is this urgent?',
    },
  },
}

const deps: JevDeps = { OPENROUTER_API_KEY: 'or-test' }

describe('evaluateSystemOne', () => {
  it('posts state and questions to the OpenRouter Decisions API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        expect(String(input)).toBe(OPENROUTER_DECISIONS_URL)
        expect(init?.method).toBe('POST')
        const headers = new Headers(init?.headers)
        expect(headers.get('Authorization')).toBe('Bearer or-test')
        const body = JSON.parse(String(init?.body)) as {
          model: string
          state: unknown
          questions: unknown
        }
        expect(body.model).toBe(JEV_MODEL)
        expect(body.state).toEqual(request.state)
        expect(body.questions).toEqual(request.questions)
        return Response.json({
          model: 'jev-1.13.0',
          answers: {
            topic: {
              type: 'choice',
              choice: 'tech',
              confidence: 0.91,
              probabilities: { tech: 0.94, science: 0.06 },
            },
            urgent: { type: 'noul', noul: 0.12 },
          },
          usage: { input_tokens: 410, output_tokens: 22 },
        })
      }),
    )
    try {
      const result = await evaluateSystemOne(request, deps)
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.value.model).toBe('jev-1.13.0')
      expect(result.value.usage.inputTokens).toBe(410)
      expect(result.value.answers.topic).toMatchObject({
        type: 'choice',
        choice: 'tech',
        confidence: 0.91,
      })
      expect(result.value.answers.urgent).toEqual({ type: 'noul', noul: 0.12 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails when OPENROUTER_API_KEY is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      for (const missing of [{}, { OPENROUTER_API_KEY: '' }, { OPENROUTER_API_KEY: '  ' }] as JevDeps[]) {
        const result = await evaluateSystemOne(request, missing)
        expect(result.ok).toBe(false)
        if (result.ok) {
          return
        }
        expect(result.error.kind).toBe('jev_failed')
        expect(result.error.code).toBe('missing_key')
        expect(result.error.reason).toContain('OPENROUTER_API_KEY')
      }
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails on non-2xx and malformed payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'nope' }, { status: 401 })),
    )
    try {
      const unauthorized = await evaluateSystemOne(request, deps)
      expect(unauthorized.ok).toBe(false)
      if (unauthorized.ok) {
        return
      }
      expect(unauthorized.error.code).toBe('http')
      expect(unauthorized.error.reason).toBe('OpenRouter HTTP 401')
    } finally {
      vi.unstubAllGlobals()
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          model: 'jev-1.13.0',
          answers: { topic: { type: 'choice', choice: 'tech', confidence: 1 } },
        }),
      ),
    )
    try {
      const malformed = await evaluateSystemOne(request, deps)
      expect(malformed.ok).toBe(false)
      if (malformed.ok) {
        return
      }
      expect(malformed.error.code).toBe('invalid_payload')
      expect(malformed.error.reason).toContain('valid Decisions payload')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('times out hanging Decisions requests', async () => {
    expect(JEV_TIMEOUT_MS).toBe(8_000)
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    try {
      const pending = evaluateSystemOne(request, deps)
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS)
      const result = await pending
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.code).toBe('timeout')
      expect(result.error.reason).toBe('OpenRouter request timed out')
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
