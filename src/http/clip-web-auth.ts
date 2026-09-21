import type { Context } from 'hono'
import type { AppEnv } from '../types'
import { clipTokenAuthorized, unauthorizedResponse } from './auth'
import {
  CANDIDATE_SESSION_COOKIE,
  parseCandidateSession,
  parseCookieHeader,
  type CandidateSession,
} from './candidate-session'
import { htmlResponse, loginPageHtml } from '../candidates/html'

export function requestIsHttps(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === 'https:'
}

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

export async function bearerOk(c: Context<AppEnv>): Promise<boolean> {
  return clipTokenAuthorized(c.req.header('authorization'), c.env.CLIP_TOKEN)
}

export async function sessionFrom(c: Context<AppEnv>): Promise<CandidateSession | null> {
  const raw = parseCookieHeader(c.req.header('cookie'), CANDIDATE_SESSION_COOKIE)
  return parseCandidateSession(raw, c.env.CLIP_TOKEN)
}

export type ClipWebAuth =
  | { readonly via: 'bearer' }
  | { readonly via: 'session'; readonly session: CandidateSession }

export async function requireClipWebAuth(c: Context<AppEnv>): Promise<ClipWebAuth | Response> {
  if (await bearerOk(c)) {
    return { via: 'bearer' }
  }
  const session = await sessionFrom(c)
  if (session !== null) {
    return { via: 'session', session }
  }
  if (wantsJson(c)) {
    return unauthorizedResponse('bearer')
  }
  if (c.req.method === 'GET') {
    return c.redirect('/candidates/login', 302)
  }
  return htmlResponse('入る', loginPageHtml('認証が必要です'), 401)
}
