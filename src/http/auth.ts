const encoder = new TextEncoder()

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

export async function secretsEqual(actual: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(actual), sha256(expected)])
  let diff = actual.length === 0 || expected.length === 0 ? 1 : 0
  for (let i = 0; i < left.byteLength; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}

export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null
  }
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header)
  return match?.[1] ?? null
}

export function parseBasicCredentials(
  header: string | undefined,
): { readonly username: string; readonly password: string } | null {
  if (header === undefined) {
    return null
  }
  const match = /^Basic[ \t]+(\S+)$/i.exec(header)
  if (match === null || match[1] === undefined) {
    return null
  }
  try {
    const decoded = atob(match[1])
    const colon = decoded.indexOf(':')
    if (colon < 0) {
      return null
    }
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
  } catch {
    return null
  }
}

export function unauthorizedResponse(scheme: 'bearer' | 'basic'): Response {
  const wwwAuthenticate = scheme === 'basic' ? 'Basic realm="Xteink Read Later"' : 'Bearer'
  return Response.json(
    { error: { status: 401, code: 'unauthorized', message: 'Unauthorized' } },
    {
      status: 401,
      headers: {
        'www-authenticate': wwwAuthenticate,
      },
    },
  )
}

export async function clipTokenAuthorized(
  header: string | undefined,
  expectedToken: string | undefined,
): Promise<boolean> {
  const presented = parseBearerToken(header)
  return secretsEqual(presented ?? '', expectedToken ?? '')
}

export async function opdsBasicAuthorized(
  header: string | undefined,
  expectedUser: string | undefined,
  expectedPassword: string | undefined,
): Promise<boolean> {
  const presented = parseBasicCredentials(header)
  const userOk = await secretsEqual(presented?.username ?? '', expectedUser ?? '')
  const passOk = await secretsEqual(presented?.password ?? '', expectedPassword ?? '')
  return userOk && passOk
}

const SHA256_HEX = /^[0-9a-f]{64}$/

async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256(value)
  let hex = ''
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function hexEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Blank, whitespace, and anything that is not 64 hex digits is unset.
 * Callers store a SHA-256 digest, never the raw smoke secret.
 */
export function configuredSmokeHash(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim().toLowerCase()
  if (!SHA256_HEX.test(normalized)) {
    return null
  }
  return normalized
}

/** SHA-256 of `username:password`, the string Basic auth decodes. No extra newline. */
export function smokeBasicMaterial(username: string, password: string): string {
  return `${username}:${password}`
}

/** Hash the presented value and compare to a stored digest. An empty presented value never matches. */
export async function presentedMatchesSha256(presented: string, expectedHash: string): Promise<boolean> {
  const actual = await sha256Hex(presented)
  const matches = hexEqual(actual, expectedHash.toLowerCase())
  return presented.length > 0 && matches
}

export async function sha256HexDigest(value: string): Promise<string> {
  return sha256Hex(value)
}

export type CredentialPrincipal = 'production' | 'smoke'

export async function resolveClipPrincipal(
  header: string | undefined,
  productionToken: string | undefined,
  smokeTokenHash: string | undefined,
): Promise<CredentialPrincipal | null> {
  if (await clipTokenAuthorized(header, productionToken)) {
    return 'production'
  }
  const smokeHash = configuredSmokeHash(smokeTokenHash)
  if (smokeHash === null) {
    return null
  }
  const presented = parseBearerToken(header)
  if (presented === null || !(await presentedMatchesSha256(presented, smokeHash))) {
    return null
  }
  return 'smoke'
}

export async function resolveOpdsPrincipal(
  header: string | undefined,
  productionUser: string | undefined,
  productionPassword: string | undefined,
  smokeBasicHash: string | undefined,
): Promise<CredentialPrincipal | null> {
  if (await opdsBasicAuthorized(header, productionUser, productionPassword)) {
    return 'production'
  }
  const smokeHash = configuredSmokeHash(smokeBasicHash)
  if (smokeHash === null) {
    return null
  }
  const presented = parseBasicCredentials(header)
  if (presented === null || presented.username.length === 0 || presented.password.length === 0) {
    return null
  }
  const material = smokeBasicMaterial(presented.username, presented.password)
  if (!(await presentedMatchesSha256(material, smokeHash))) {
    return null
  }
  return 'smoke'
}

export function forbiddenResponse(): Response {
  return Response.json(
    { error: { status: 403, code: 'forbidden', message: 'Forbidden' } },
    { status: 403 },
  )
}
