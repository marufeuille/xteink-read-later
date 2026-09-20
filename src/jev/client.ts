import type {
  EvaluateSystemOne,
  JevErrorCode,
  JevFailedError,
  Result,
  SystemOneAnswer,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResult,
  SystemOneUsage,
} from '../types'
import { err, ok } from '../types/result.ts'
import {
  JEV_APP_TITLE,
  JEV_HTTP_REFERER,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  OPENROUTER_DECISIONS_URL,
} from './constants.ts'

function fail(code: JevErrorCode, reason: string): Result<SystemOneResult, JevFailedError> {
  return err({ kind: 'jev_failed', code, reason })
}

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    (cause.name === 'AbortError' || cause.name === 'TimeoutError')
  )
}

export function openRouterApiKey(deps: { readonly OPENROUTER_API_KEY?: string }): string | null {
  const key = deps.OPENROUTER_API_KEY
  if (typeof key !== 'string') {
    return null
  }
  const trimmed = key.trim()
  return trimmed.length > 0 ? trimmed : null
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError')
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError()
  }
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(resolve, reject)
    })
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseProbabilities(value: unknown): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) {
    return null
  }
  const probabilities: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    const probability = finiteNumber(entry)
    if (probability === null) {
      return null
    }
    probabilities[key] = probability
  }
  return probabilities
}

function parseLegend(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    return {}
  }
  const legend: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      legend[key] = entry
    }
  }
  return legend
}

function parseChoiceFields(value: Record<string, unknown>): {
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
} {
  return {
    confidence: finiteNumber(value.confidence) ?? 0,
    probabilities: parseProbabilities(value.probabilities) ?? {},
  }
}

function parseAnswer(value: unknown): SystemOneAnswer | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null
  }
  switch (value.type) {
    case 'noul': {
      const noul = finiteNumber(value.noul)
      return noul === null ? null : { type: 'noul', noul }
    }
    case 'choice': {
      if (typeof value.choice !== 'string' || value.choice.length === 0) {
        return null
      }
      return { type: 'choice', choice: value.choice, ...parseChoiceFields(value) }
    }
    case 'score': {
      const score = finiteNumber(value.score)
      if (score === null) {
        return null
      }
      return { type: 'score', score, legend: parseLegend(value.legend), ...parseChoiceFields(value) }
    }
    default:
      return null
  }
}

function parseUsage(value: unknown): SystemOneUsage {
  if (!isRecord(value)) {
    return { inputTokens: null, outputTokens: null }
  }
  return {
    inputTokens: finiteNumber(value.input_tokens) ?? finiteNumber(value.inputTokens),
    outputTokens: finiteNumber(value.output_tokens) ?? finiteNumber(value.outputTokens),
  }
}

function parseResult(payload: unknown, questions: Readonly<Record<string, SystemOneQuestion>>): SystemOneResult | null {
  if (!isRecord(payload) || !isRecord(payload.answers) || typeof payload.model !== 'string') {
    return null
  }
  const answers: Record<string, SystemOneAnswer> = {}
  for (const key of Object.keys(questions)) {
    const parsed = parseAnswer(payload.answers[key])
    if (parsed === null || parsed.type !== questions[key]?.type) {
      return null
    }
    answers[key] = parsed
  }
  return {
    model: payload.model,
    answers,
    usage: parseUsage(payload.usage),
  }
}

function openRouterHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': JEV_HTTP_REFERER,
    'X-OpenRouter-Title': JEV_APP_TITLE,
  }
}

export const evaluateSystemOne: EvaluateSystemOne = async (request: SystemOneRequest, deps) => {
  const apiKey = openRouterApiKey(deps)
  if (apiKey === null) {
    return fail('missing_key', 'OPENROUTER_API_KEY is not set')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS)
  try {
    const response = await raceAbort(
      fetch(OPENROUTER_DECISIONS_URL, {
        method: 'POST',
        headers: openRouterHeaders(apiKey),
        signal: controller.signal,
        body: JSON.stringify({
          model: JEV_MODEL,
          state: request.state,
          questions: request.questions,
        }),
      }),
      controller.signal,
    )

    if (!response.ok) {
      return fail('http', `OpenRouter HTTP ${response.status}`)
    }

    const payload: unknown = await raceAbort(response.json(), controller.signal)
    const parsed = parseResult(payload, request.questions)
    if (parsed === null) {
      return fail('invalid_payload', 'OpenRouter response was not a valid Decisions payload')
    }
    return ok(parsed)
  } catch (cause) {
    if (controller.signal.aborted || isAbortError(cause)) {
      return fail('timeout', 'OpenRouter request timed out')
    }
    const reason = cause instanceof Error ? cause.message : String(cause)
    return fail('network', reason)
  } finally {
    clearTimeout(timer)
  }
}
