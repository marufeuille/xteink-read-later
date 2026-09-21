import type { Context } from 'hono'
import { accessRequiredHtml, htmlResponse } from '../candidates/html'
import type { AppEnv } from '../types'
import {
  defaultGetAccessIdentity,
  type GetAccessIdentity,
} from './access-identity'
import { clipTokenAuthorized, unauthorizedResponse } from './auth'
import { accessCsrfToken, csrfTokensMatch } from './candidate-session'
import { toErrorResponse } from './error-response'

export const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout'

export function wantsJson(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname
  if (path.endsWith('.json')) {
    return true
  }
  const accept = c.req.header('accept') ?? ''
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return true
  }
  const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  return contentType === 'application/json'
}

export type ClipWebAuth = {
  readonly via: 'bearer' | 'access'
  readonly csrfToken: string
}

export async function presentedCsrf(c: Context<AppEnv>, json: boolean): Promise<string> {
  if (json) {
    return c.req.header('x-csrf-token') ?? ''
  }
  try {
    const form = await c.req.parseBody()
    return typeof form.csrf === 'string' ? form.csrf : ''
  } catch {
    return ''
  }
}

export async function denyIfCsrfMismatch(
  auth: ClipWebAuth,
  presented: string | undefined,
): Promise<Response | null> {
  if (auth.via === 'access' && !(await csrfTokensMatch(presented, auth.csrfToken))) {
    return toErrorResponse({ kind: 'csrf_failed' })
  }
  return null
}

export async function requireClipWebAuth(
  c: Context<AppEnv>,
  getAccessIdentity: GetAccessIdentity = defaultGetAccessIdentity,
): Promise<ClipWebAuth | Response> {
  if (await clipTokenAuthorized(c.req.header('authorization'), c.env.CLIP_TOKEN)) {
    return { via: 'bearer', csrfToken: '' }
  }
  const identity = await getAccessIdentity(c)
  if (identity !== null) {
    return {
      via: 'access',
      csrfToken: await accessCsrfToken(identity.email, c.env.CLIP_TOKEN),
    }
  }
  if (wantsJson(c)) {
    return unauthorizedResponse('bearer')
  }
  return htmlResponse('Google アカウントで入る', accessRequiredHtml(), 401)
}
