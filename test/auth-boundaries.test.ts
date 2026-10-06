import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  digestQrExpiresAt,
  issueDateFromDigestQrExpires,
  signDigestQrToken,
  verifyDigestQrToken,
  workerPublicOrigin,
} from '../src/digest/confirm-link'
import { defaultGetAccessIdentity } from '../src/http/access-identity'
import {
  configuredSmokeHash,
  forbiddenResponse,
  parseBasicCredentials,
  parseBearerToken,
  presentedMatchesSha256,
  resolveClipPrincipal,
  resolveOpdsPrincipal,
  sha256HexDigest,
  smokeBasicMaterial,
  unauthorizedResponse,
} from '../src/http/auth'
import { accessCsrfToken } from '../src/http/candidate-session'
import { presentedCsrf, wantsJson } from '../src/http/clip-web-auth'
import type { AppEnv } from '../src/types'

const CANDIDATE = 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

function accessContext(email: string): Context<AppEnv> {
  return {
    executionCtx: {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
      access: {
        aud: 'test-aud',
        getIdentity: async () => ({ email }),
      },
    },
  } as unknown as Context<AppEnv>
}

function requestContext(input: {
  readonly path?: string
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
}): Context<AppEnv> {
  const headers = new Headers(input.headers)
  return {
    req: {
      url: `http://example.com${input.path ?? '/candidates'}`,
      header: (name: string) => headers.get(name) ?? undefined,
      parseBody: async () => input.body ?? {},
    },
  } as unknown as Context<AppEnv>
}

describe('auth boundaries', () => {
  it('parses Bearer only as a whole scheme plus token', () => {
    expect(parseBearerToken('Bearer tok')).toBe('tok')
    expect(parseBearerToken('Bearer  tok')).toBe('tok')
    expect(parseBearerToken('Bearer\ttok')).toBe('tok')
    expect(parseBearerToken('xBearer tok')).toBeNull()
    expect(parseBearerToken('Bearer tok extra')).toBeNull()
  })

  it('parses Basic only as a whole scheme plus user and password', () => {
    const encoded = btoa('user:p:ass')
    expect(parseBasicCredentials(`Basic ${encoded}`)).toEqual({ username: 'user', password: 'p:ass' })
    expect(parseBasicCredentials(`Basic  ${encoded}`)).toEqual({ username: 'user', password: 'p:ass' })
    expect(parseBasicCredentials(`xBasic ${encoded}`)).toBeNull()
    expect(parseBasicCredentials(`Basic ${encoded} extra`)).toBeNull()
    expect(parseBasicCredentials(`Basic ${btoa('nocolon')}`)).toBeNull()
    expect(parseBasicCredentials(`Basic ${btoa(':secret')}`)).toEqual({ username: '', password: 'secret' })
    expect(parseBasicCredentials('Basic !!!!')).toBeNull()
  })

  it('accepts a smoke hash only when it is exactly 64 hex digits', () => {
    expect(configuredSmokeHash(HASH_ABC)).toBe(HASH_ABC)
    expect(configuredSmokeHash(`zz${HASH_ABC}`)).toBeNull()
    expect(configuredSmokeHash(`${HASH_ABC}zz`)).toBeNull()
  })

  it('rejects a digest that is only a prefix of the stored hash', async () => {
    expect(await presentedMatchesSha256('abc', `${HASH_ABC}aa`)).toBe(false)
    expect(await presentedMatchesSha256('abc', HASH_ABC)).toBe(true)
  })

  it('names the production principal and does not treat a missing token as smoke', async () => {
    const smokeHash = await sha256HexDigest('smoke-token')
    expect(await resolveClipPrincipal('Bearer prod-token', 'prod-token', smokeHash)).toBe('production')
    expect(await resolveClipPrincipal(undefined, 'prod-token', smokeHash)).toBeNull()

    expect(await resolveOpdsPrincipal(`Basic ${btoa('user:pass')}`, 'user', 'pass', smokeHash)).toBe('production')
    expect(await resolveOpdsPrincipal(undefined, 'user', 'pass', smokeHash)).toBeNull()

    const emptyUser = await sha256HexDigest(smokeBasicMaterial('', 'secret'))
    expect(await resolveOpdsPrincipal(`Basic ${btoa(':secret')}`, 'user', 'pass', emptyUser)).toBeNull()
    const emptyPassword = await sha256HexDigest(smokeBasicMaterial('user', ''))
    expect(await resolveOpdsPrincipal(`Basic ${btoa('user:')}`, 'user', 'pass', emptyPassword)).toBeNull()
  })

  it('returns the unauthorized and forbidden bodies', async () => {
    const unauthorized = unauthorizedResponse('bearer')
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({
      error: { status: 401, code: 'unauthorized', message: 'Unauthorized' },
    })
    const forbidden = forbiddenResponse()
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({
      error: { status: 403, code: 'forbidden', message: 'Forbidden' },
    })
  })

  it('trims an Access email and rejects whitespace', async () => {
    expect(await defaultGetAccessIdentity(accessContext('   '))).toBeNull()
    expect(await defaultGetAccessIdentity(accessContext('  admin@example.com  '))).toEqual({
      email: 'admin@example.com',
    })
  })

  it('binds the Access CSRF token to a non-empty email and clip token', async () => {
    expect(await accessCsrfToken('', 'tok')).toBe('')
    expect(await accessCsrfToken('a@b.c', '')).toBe('')
    const first = await accessCsrfToken('a@b.c', 'tok')
    const second = await accessCsrfToken('c@d.e', 'tok')
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(second)
  })

  it('treats a JSON content type with a space before the parameter as JSON', () => {
    expect(
      wantsJson(
        requestContext({
          headers: { 'content-type': 'application/json ; charset=utf-8' },
        }),
      ),
    ).toBe(true)
  })

  it('reads the CSRF token from the JSON header or the form field', async () => {
    expect(await presentedCsrf(requestContext({ headers: { 'x-csrf-token': 'tok' } }), true)).toBe('tok')
    expect(await presentedCsrf(requestContext({}), true)).toBe('')
    expect(await presentedCsrf(requestContext({ body: { csrf: 'form-tok' } }), false)).toBe('form-tok')
    expect(await presentedCsrf(requestContext({ body: {} }), false)).toBe('')
    const brokenForm = requestContext({})
    brokenForm.req.parseBody = async () => {
      throw new Error('bad form')
    }
    expect(await presentedCsrf(brokenForm, false)).toBe('')
  })

  it('rejects an invalid issue date and keeps a single-digit day', () => {
    expect(() => digestQrExpiresAt('not-a-date')).toThrow(TypeError)
    expect(issueDateFromDigestQrExpires(digestQrExpiresAt('2026-09-05'))).toBe('2026-09-05')
  })

  it('signs only with a secret and a non-negative expiry, and verifies the canonical decimal', async () => {
    await expect(signDigestQrToken({ secret: '', candidateId: CANDIDATE, expiresAt: 1 })).rejects.toThrow(TypeError)
    await expect(signDigestQrToken({ secret: 's', candidateId: CANDIDATE, expiresAt: -1 })).rejects.toThrow(TypeError)
    const zero = await signDigestQrToken({ secret: 's', candidateId: CANDIDATE, expiresAt: 0 })
    expect(zero).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const token = await signDigestQrToken({ secret: 's0', candidateId: CANDIDATE, expiresAt: 1 })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).not.toContain('+')
    expect(token).not.toContain('/')

    expect(
      await verifyDigestQrToken({
        secret: '',
        candidateId: CANDIDATE,
        expiresAt: '1',
        token,
        nowMs: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(
      await verifyDigestQrToken({
        secret: 's0',
        candidateId: 'not-a-candidate',
        expiresAt: '1',
        token,
        nowMs: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(
      await verifyDigestQrToken({
        secret: 's0',
        candidateId: CANDIDATE,
        expiresAt: '01',
        token,
        nowMs: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(
      await verifyDigestQrToken({
        secret: 's0',
        candidateId: CANDIDATE,
        expiresAt: '1',
        token: 'short',
        nowMs: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(
      await verifyDigestQrToken({
        secret: 's0',
        candidateId: CANDIDATE,
        expiresAt: '1x',
        token,
        nowMs: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid' })
  })

  it('accepts only an origin, not userinfo, a query, a hash, or a non-URL', () => {
    expect(workerPublicOrigin('https://user@read.example.com')).toBeNull()
    expect(workerPublicOrigin('https://:secret@read.example.com')).toBeNull()
    expect(workerPublicOrigin('https://read.example.com/?q=1')).toBeNull()
    expect(workerPublicOrigin('https://read.example.com/#x')).toBeNull()
    expect(workerPublicOrigin('not a url')).toBeNull()
  })
})
