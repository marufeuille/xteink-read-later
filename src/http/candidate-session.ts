import { secretsEqual } from './auth'

export const CANDIDATE_SESSION_COOKIE = 'xr_candidates'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

const encoder = new TextEncoder()

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return bytesToHex(new Uint8Array(mac))
}

export type CandidateSession = {
  readonly exp: number
  readonly cookieValue: string
  readonly csrfToken: string
}

export async function createCandidateSession(
  clipToken: string,
  nowMs: number = Date.now(),
): Promise<CandidateSession> {
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS
  const payload = `v1.${exp}`
  const mac = await hmacHex(clipToken, payload)
  const csrfToken = await hmacHex(clipToken, `csrf.${payload}`)
  return {
    exp,
    cookieValue: `${payload}.${mac}`,
    csrfToken,
  }
}

export async function parseCandidateSession(
  cookieValue: string | undefined,
  clipToken: string,
  nowMs: number = Date.now(),
): Promise<CandidateSession | null> {
  if (cookieValue === undefined || clipToken.length === 0) {
    return null
  }
  const match = /^v1\.(\d+)\.([0-9a-f]+)$/.exec(cookieValue)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null
  }
  const exp = Number(match[1])
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs) {
    return null
  }
  const payload = `v1.${exp}`
  const expectedMac = await hmacHex(clipToken, payload)
  if (!(await secretsEqual(match[2], expectedMac))) {
    return null
  }
  const csrfToken = await hmacHex(clipToken, `csrf.${payload}`)
  return { exp, cookieValue, csrfToken }
}

export async function csrfTokensMatch(
  presented: string | undefined,
  expected: string,
): Promise<boolean> {
  return secretsEqual(presented ?? '', expected)
}

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length === 0) {
    return undefined
  }
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) {
      continue
    }
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1))
    }
  }
  return undefined
}

export function candidateSessionSetCookie(session: CandidateSession, secure: boolean): string {
  const parts = [
    `${CANDIDATE_SESSION_COOKIE}=${encodeURIComponent(session.cookieValue)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
  if (secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

export function candidateSessionClearCookie(secure: boolean): string {
  const parts = [
    `${CANDIDATE_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ]
  if (secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}
