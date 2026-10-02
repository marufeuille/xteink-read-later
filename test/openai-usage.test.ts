import { describe, expect, it } from 'vitest'
import { BAKEOFF_MODELS } from '../src/translate/bakeoff-run'
import { OPENAI_MODEL } from '../src/translate/constants'
import {
  estimateOpenAiUsd,
  OPENAI_USD_PER_MILLION,
  readOpenAiChatUsage,
} from '../src/translate/openai-usage'

describe('OpenAI usage estimate', () => {
  it('shares bakeoff USD rates and does not invent a price for unknown models', () => {
    for (const model of BAKEOFF_MODELS) {
      if (model.provider !== 'openai') {
        expect(OPENAI_USD_PER_MILLION[model.id]).toBeUndefined()
        continue
      }
      expect(OPENAI_USD_PER_MILLION[model.id]).toEqual({
        input: model.inputUsdPerMillion,
        output: model.outputUsdPerMillion,
      })
    }
    expect(OPENAI_MODEL).toBe('gpt-5.6-luna')
    expect(estimateOpenAiUsd(OPENAI_MODEL, 1_000_000, 1_000_000)).toBe(1.4)
    expect(estimateOpenAiUsd(OPENAI_MODEL, 1250, 450)).toBe(0.00079)
    expect(estimateOpenAiUsd(OPENAI_MODEL, 80, 20)).toBe(0.00004)
    expect(estimateOpenAiUsd(OPENAI_MODEL, 0, 0)).toBe(0)
    expect(estimateOpenAiUsd('unknown-model', 10, 10)).toBeNull()
    expect(estimateOpenAiUsd(OPENAI_MODEL, Number.NaN, 1)).toBeNull()
    expect(estimateOpenAiUsd(OPENAI_MODEL, -1, 1)).toBeNull()
  })

  it('reads prompt_tokens and completion_tokens as truncated non-negative integers', () => {
    expect(readOpenAiChatUsage({ usage: { prompt_tokens: 3.8, completion_tokens: 1 } })).toEqual({
      promptTokens: 3,
      completionTokens: 1,
    })
    expect(readOpenAiChatUsage({ usage: { input_tokens: 9, output_tokens: 4 } })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    })
    expect(readOpenAiChatUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0 })
  })
})
