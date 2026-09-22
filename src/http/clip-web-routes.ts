import type { Context, Hono } from 'hono'
import { htmlResponse } from '../candidates/html'
import { clipWebBookmarklet } from '../clip/bookmarklet'
import {
  clipWebConfirmHtml,
  clipWebInvalidHtml,
  clipWebMissingHtml,
  clipWebResultHtml,
  clipWebSecretHtml,
  clipWebUrlContainsSecret,
  clipWebUrlPreview,
} from '../clip/html'
import { parseClipUrl } from '../extract/parse-clip-url'
import { enqueueClipJob } from '../job/enqueue'
import { createR2Store } from '../store/r2'
import type { AppEnv, ArticleStore, ClipQueueMessage, CreateArticleStore } from '../types'
import { defaultGetAccessIdentity, type GetAccessIdentity } from './access-identity'
import { toClipQueuedBody } from './clip-job'
import { parseClipShareText } from './clip-request'
import { denyIfCsrfMismatch, requireClipWebAuth, wantsJson } from './clip-web-auth'
import { toErrorResponse } from './error-response'

export type ClipWebDeps = {
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly queue?: Queue<ClipQueueMessage>
  readonly getAccessIdentity?: GetAccessIdentity
}

function storeFor(env: Cloudflare.Env, deps: ClipWebDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  return (deps.createStore ?? createR2Store)(env)
}

function queueFor(env: Cloudflare.Env, deps: ClipWebDeps): Queue<ClipQueueMessage> {
  return deps.queue ?? env.CLIP_QUEUE
}

async function readSubmission(
  c: Context<AppEnv>,
  json: boolean,
): Promise<{ readonly url: string; readonly csrf: string } | Response> {
  if (json) {
    let raw = ''
    try {
      raw = await c.req.text()
    } catch {
      return toErrorResponse({ kind: 'invalid_url', url: '' })
    }
    return {
      url: parseClipShareText(c.req.header('content-type'), raw) ?? '',
      csrf: c.req.header('x-csrf-token') ?? '',
    }
  }
  try {
    const form = await c.req.parseBody()
    return {
      url: typeof form.url === 'string' ? form.url : '',
      csrf: typeof form.csrf === 'string' ? form.csrf : '',
    }
  } catch {
    return htmlResponse('記事をクリップ', '<h1>入力を読み取れませんでした</h1>', 400)
  }
}

export function mountClipWebRoutes(app: Hono<AppEnv>, deps: ClipWebDeps = {}): void {
  const webAuth = (c: Context<AppEnv>) =>
    requireClipWebAuth(c, deps.getAccessIdentity ?? defaultGetAccessIdentity)

  const show = async (c: Context<AppEnv>) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const raw = c.req.query('url') ?? ''
    if (raw.trim() === '') {
      return htmlResponse('記事をクリップ', clipWebMissingHtml(clipWebBookmarklet(new URL(c.req.url).origin)))
    }
    if (clipWebUrlContainsSecret(raw, c.env.CLIP_TOKEN)) {
      return htmlResponse('記事をクリップ', clipWebSecretHtml(), 400)
    }
    const parsed = parseClipUrl({ url: raw })
    if (!parsed.ok) {
      return htmlResponse('記事をクリップ', clipWebInvalidHtml(clipWebUrlPreview(raw, c.env.CLIP_TOKEN)), 400)
    }
    return htmlResponse(
      '記事をクリップ',
      clipWebConfirmHtml({
        url: parsed.value,
        csrfToken: auth.csrfToken,
      }),
    )
  }

  const submit = async (c: Context<AppEnv>) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const read = await readSubmission(c, json)
    if (read instanceof Response) {
      return read
    }
    const denied = await denyIfCsrfMismatch(auth, read.csrf)
    if (denied !== null) {
      return denied
    }
    if (clipWebUrlContainsSecret(read.url, c.env.CLIP_TOKEN)) {
      return json
        ? toErrorResponse({ kind: 'invalid_url', url: '' })
        : htmlResponse('記事をクリップ', clipWebSecretHtml(), 400)
    }
    const parsed = parseClipUrl({ url: read.url })
    if (!parsed.ok) {
      return json
        ? toErrorResponse(parsed.error)
        : htmlResponse('記事をクリップ', clipWebInvalidHtml(clipWebUrlPreview(read.url, c.env.CLIP_TOKEN)), 400)
    }
    const queued = await enqueueClipJob({
      store: storeFor(c.env, deps),
      queue: queueFor(c.env, deps),
      url: parsed.value,
      nowMs: Date.now(),
      reuseReady: false,
    })
    if (!queued.ok) {
      return json
        ? toErrorResponse(queued.error)
        : htmlResponse('記事をクリップ', clipWebResultHtml({ kind: 'failed' }), 503)
    }
    const location = `/clip/jobs/${queued.job.jobId}`
    if (json) {
      c.header('Location', location)
      return c.json(toClipQueuedBody(queued.job), 202)
    }
    return htmlResponse(
      '記事をクリップ',
      clipWebResultHtml({
        kind: queued.kind === 'queued' ? 'queued' : 'active',
        jobId: queued.job.jobId,
      }),
      202,
      { location },
    )
  }

  app.on('GET', ['/clip/web', '/clip/web/'], show)
  app.on('POST', ['/clip/web', '/clip/web/'], submit)
}
