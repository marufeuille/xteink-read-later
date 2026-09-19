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
