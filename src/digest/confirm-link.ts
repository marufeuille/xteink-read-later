import { secretsEqual } from '../http/auth'
import { isCandidateId, parseHttpUrl, type CandidateId } from '../types'
import { DIGEST_QR_TTL_DAYS } from '../types/daily'

const encoder = new TextEncoder()
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const EXPIRES_PATTERN = /^[0-9]{1,16}$/

export function digestQrExpiresAt(issueDate: string): number {
  const start = Date.parse(`${issueDate}T00:00:00+09:00`)
  if (!Number.isFinite(start)) {
    throw new TypeError(`Invalid issue date: ${issueDate}`)
  }
  return Math.floor(start / 1000) + DIGEST_QR_TTL_DAYS * 24 * 60 * 60
}

/** Origin only. A path, query, hash, or userinfo means the value is not a public origin. */
export function workerPublicOrigin(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  const parsed = parseHttpUrl(trimmed)
  if (parsed === null) {
    return null
  }
  const url = new URL(parsed)
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null
  }
  if (url.pathname !== '/') {
    return null
  }
  return url.origin
}

function payload(candidateId: string, expiresAt: number): string {
  return `${candidateId}.${expiresAt}`
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function signDigestQrToken(input: {
  readonly secret: string
  readonly candidateId: string
  readonly expiresAt: number
}): Promise<string> {
  if (input.secret.length === 0) {
    throw new TypeError('QR signing secret is empty')
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
    throw new TypeError('QR expiry is invalid')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload(input.candidateId, input.expiresAt)))
  return base64Url(new Uint8Array(signed))
}

export type DigestQrCheck =
  | { readonly ok: true; readonly candidateId: CandidateId; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' }

export async function verifyDigestQrToken(input: {
  readonly secret: string
  readonly candidateId: string
  readonly expiresAt: string
  readonly token: string
  readonly nowMs: number
}): Promise<DigestQrCheck> {
  if (input.secret.length === 0 || !isCandidateId(input.candidateId)) {
    return { ok: false, reason: 'invalid' }
  }
  if (!EXPIRES_PATTERN.test(input.expiresAt) || !TOKEN_PATTERN.test(input.token)) {
    return { ok: false, reason: 'invalid' }
  }
  const expiresAt = Number(input.expiresAt)
  if (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== input.expiresAt) {
    return { ok: false, reason: 'invalid' }
  }
  const expected = await signDigestQrToken({
    secret: input.secret,
    candidateId: input.candidateId,
    expiresAt,
  })
  if (!(await secretsEqual(input.token, expected))) {
    return { ok: false, reason: 'invalid' }
  }
  if (input.nowMs >= expiresAt * 1000) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, candidateId: input.candidateId, expiresAt }
}

export function digestConfirmPath(candidateId: string, expiresAt: number, token: string): string {
  return `/digest/send/${candidateId}/${expiresAt}/${token}`
}

export function digestConfirmUrl(
  origin: string,
  candidateId: string,
  expiresAt: number,
  token: string,
): string {
  return `${origin}${digestConfirmPath(candidateId, expiresAt, token)}`
}
