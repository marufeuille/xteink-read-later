import type { OpenAiTokenUsage } from '../types/pipeline'

export type { OpenAiTokenUsage }

export const ZERO_OPENAI_TOKEN_USAGE: OpenAiTokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
}

/**
 * USD per 1,000,000 tokens.
 * Shared with bakeoff (`src/translate/bakeoff-run.ts`) so clip observability
 * does not drift from that table. This is an estimate for dashboards, not the
 * OpenAI invoice.
 */
export const OPENAI_USD_PER_MILLION: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
}

export function withOpenAiUsage<T>(
  result: T,
  usage: OpenAiTokenUsage = ZERO_OPENAI_TOKEN_USAGE,
): T & { readonly usage: OpenAiTokenUsage } {
  return { ...result, usage }
}

function tokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0
  }
  return Math.trunc(value)
}

export function normalizeOpenAiUsage(usage: OpenAiTokenUsage | undefined): OpenAiTokenUsage {
  if (usage === undefined) {
    return ZERO_OPENAI_TOKEN_USAGE
  }
  return {
    promptTokens: tokenCount(usage.promptTokens),
    completionTokens: tokenCount(usage.completionTokens),
  }
}

export function addOpenAiUsage(left: OpenAiTokenUsage, right: OpenAiTokenUsage): OpenAiTokenUsage {
  const a = normalizeOpenAiUsage(left)
  const b = normalizeOpenAiUsage(right)
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  }
}

/** `usage.prompt_tokens` / `usage.completion_tokens` from a chat completion payload. */
export function readOpenAiChatUsage(payload: unknown): OpenAiTokenUsage {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return ZERO_OPENAI_TOKEN_USAGE
  }
  const usage = (payload as { readonly usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    return ZERO_OPENAI_TOKEN_USAGE
  }
  const record = usage as { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown }
  return normalizeOpenAiUsage({
    promptTokens: tokenCount(record.prompt_tokens),
    completionTokens: tokenCount(record.completion_tokens),
  })
}

/**
 * Approximate USD from the shared rate table.
 * Returns null when the model has no rate or the counts are not finite and non-negative.
 * Not the amount OpenAI bills.
 */
export function estimateOpenAiUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const rates = OPENAI_USD_PER_MILLION[model]
  if (rates === undefined) {
    return null
  }
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    promptTokens < 0 ||
    completionTokens < 0
  ) {
    return null
  }
  return (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output
}
