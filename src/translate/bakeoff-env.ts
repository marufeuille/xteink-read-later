import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const BAKEOFF_DOTENV_KEYS = ['OPENAI_API_KEY', 'PLAMO_API_KEY'] as const

export type BakeoffDotenvKey = (typeof BAKEOFF_DOTENV_KEYS)[number]

export type BakeoffKeys = {
  readonly openai: string | null
  readonly plamo: string | null
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = stripped.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const key = stripped.slice(0, eq).trim()
    if (key.length === 0) {
      continue
    }
    let value = stripped.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function envTrimFrom(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function applyBakeoffDotEnv(
  parsed: Record<string, string>,
  env: Record<string, string | undefined>,
): void {
  for (const name of BAKEOFF_DOTENV_KEYS) {
    if (envTrimFrom(env, name) !== null) {
      continue
    }
    const next = parsed[name]
    if (typeof next !== 'string') {
      continue
    }
    const trimmed = next.trim()
    if (trimmed.length === 0) {
      continue
    }
    env[name] = trimmed
  }
}

export function loadBakeoffKeys(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): BakeoffKeys {
  try {
    const text = readFileSync(join(repoRoot, '.dev.vars'), 'utf8')
    applyBakeoffDotEnv(parseDotEnv(text), env)
  } catch {
    // Missing .dev.vars is fine; shell env still works.
  }
  return {
    openai: envTrimFrom(env, 'OPENAI_API_KEY'),
    plamo: envTrimFrom(env, 'PLAMO_API_KEY'),
  }
}
