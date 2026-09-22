import type { Context, Hono } from 'hono'
import { enqueueDailyDigest, toDailyDigestQueuedBody } from '../daily/enqueue'
import type { AppEnv, DigestQueueMessage } from '../types'
import { defaultGetAccessIdentity, type GetAccessIdentity } from './access-identity'
import { denyIfCsrfMismatch, presentedCsrf, requireClipWebAuth, wantsJson } from './clip-web-auth'
import { toErrorResponse } from './error-response'
import { htmlResponse } from '../feeds/html'

export type DigestHttpDeps = {
  readonly digestQueue?: Queue<DigestQueueMessage>
  readonly now?: () => Date
  readonly getAccessIdentity?: GetAccessIdentity
}

function queueFor(env: Cloudflare.Env, deps: DigestHttpDeps): Queue<DigestQueueMessage> {
  return deps.digestQueue ?? env.DIGEST_QUEUE
}

export function mountDigestRoutes(app: Hono<AppEnv>, deps: DigestHttpDeps = {}): void {
  const now = deps.now ?? (() => new Date())
  const webAuth = (c: Context<AppEnv>) =>
    requireClipWebAuth(c, deps.getAccessIdentity ?? defaultGetAccessIdentity)

  app.on('POST', ['/digest', '/digest/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const denied = await denyIfCsrfMismatch(auth, await presentedCsrf(c, json))
    if (denied !== null) {
      return denied
    }
    const queued = await enqueueDailyDigest(c.env, {
      digestQueue: queueFor(c.env, deps),
      now,
    })
    if (queued.failed > 0) {
      return toErrorResponse({ kind: 'queue_failed', reason: 'Digest enqueue failed' })
    }
    if (json) {
      return c.json(toDailyDigestQueuedBody(queued.date), 202)
    }
    return htmlResponse('まとめ', '<p>まとめ生成を予約しました</p>', 202)
  })
}
