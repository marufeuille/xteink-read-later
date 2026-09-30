import type { Context, Hono } from 'hono'
import { recentClipsHtml, RECENT_CLIP_LIMIT, toRecentClip } from '../clip/recent'
import { htmlResponse } from '../candidates/html'
import { createR2Store } from '../store/r2'
import type { AppEnv, ArticleStore, CreateArticleStore } from '../types'
import { defaultGetAccessIdentity, type GetAccessIdentity } from './access-identity'
import { requireClipWebAuth, wantsJson } from './clip-web-auth'

export type ClipRecentDeps = {
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly getAccessIdentity?: GetAccessIdentity
}

function storeFor(env: Cloudflare.Env, deps: ClipRecentDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  return (deps.createStore ?? createR2Store)(env)
}

export function mountClipRecentRoutes(app: Hono<AppEnv>, deps: ClipRecentDeps = {}): void {
  const show = async (c: Context<AppEnv>) => {
    const auth = await requireClipWebAuth(c, deps.getAccessIdentity ?? defaultGetAccessIdentity)
    if (auth instanceof Response) {
      return auth
    }
    const jobs = (await storeFor(c.env, deps).listRecentJobs(RECENT_CLIP_LIMIT)).map(toRecentClip)
    if (wantsJson(c)) {
      return c.json({ jobs }, 200, { 'cache-control': 'no-store' })
    }
    return htmlResponse('最近のクリップ', recentClipsHtml(jobs), 200, { 'cache-control': 'no-store' })
  }

  app.on('GET', ['/clip/recent', '/clip/recent/'], show)
}
