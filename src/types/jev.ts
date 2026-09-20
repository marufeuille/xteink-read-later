import type { Result } from './result'

export type NoulQuestion = {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria?: {
    readonly true: string
    readonly false: string
  }
}

export type ChoiceQuestion = {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string | null>>
}

export type ScoreQuestion = {
  readonly type: 'score'
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export type NoulAnswer = {
  readonly type: 'noul'
  readonly noul: number
}

export type ChoiceAnswer = {
  readonly type: 'choice'
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
}

export type ScoreAnswer = {
  readonly type: 'score'
  readonly score: number
  readonly confidence: number
  readonly legend: Readonly<Record<string, string>>
  readonly probabilities: Readonly<Record<string, number>>
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type SystemOneRequest = {
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[]
  readonly questions: Readonly<Record<string, SystemOneQuestion>>
}

export type SystemOneUsage = {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}

export type SystemOneResult = {
  readonly model: string
  readonly answers: Readonly<Record<string, SystemOneAnswer>>
  readonly usage: SystemOneUsage
}

export type JevErrorCode = 'http' | 'timeout' | 'invalid_payload' | 'missing_key' | 'network'

export type JevFailedError = {
  readonly kind: 'jev_failed'
  readonly code: JevErrorCode
  readonly reason: string
}

export type JevDeps = Pick<Cloudflare.Env, 'OPENROUTER_API_KEY'>

export type EvaluateSystemOne = (
  request: SystemOneRequest,
  deps: JevDeps,
) => Promise<Result<SystemOneResult, JevFailedError>>
