import { secretsEqual } from './auth'

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

export async function accessCsrfToken(email: string, clipToken: string): Promise<string> {
  if (email.length === 0 || clipToken.length === 0) {
    return ''
  }
  return hmacHex(clipToken, `csrf.access.${email}`)
}

export async function csrfTokensMatch(
  presented: string | undefined,
  expected: string,
): Promise<boolean> {
  return secretsEqual(presented ?? '', expected)
}
