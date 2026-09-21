import type { Context, Hono } from 'hono'
import { sendCandidateClip } from '../candidates/clip'
import { enrichCandidatePublic, syncCandidateCompletion, candidateIdParam } from '../candidates/delivery'
import { listOffset, parseListPage, toCandidateListBodyFromPublic, toCandidatePublic } from '../candidates/list'
import { candidatesPageHtml, htmlResponse, loginPageHtml, toRegisterJson } from '../candidates/html'
import { registerCandidate } from '../candidates/register'
import { parseClipUrl } from '../extract/parse-clip-url'
import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import { createD1CandidateStore } from '../store/d1-candidates'
import { createR2Store } from '../store/r2'
import {
  CANDIDATE_LIST_PAGE_SIZE,
  type AppEnv,
  type ArticleStore,
  type CandidateNotice,
  type CandidateNoticeKind,
  type CandidateStore,
  type ClipQueueMessage,
  type CreateArticleStore,
  type FetchPage,
} from '../types'
import { clipTokenAuthorized } from './auth'
import {
  candidateSessionClearCookie,
  candidateSessionSetCookie,
  createCandidateSession,
  csrfTokensMatch,
} from './candidate-session'
import { bearerOk, requestIsHttps, requireClipWebAuth, sessionFrom, wantsJson, type ClipWebAuth } from './clip-web-auth'
import { parseClipShareText } from './clip-request'
import { toErrorResponse } from './error-response'

export type CandidateHttpDeps = {
  readonly candidateStore?: CandidateStore
  readonly createCandidateStore?: (env: Cloudflare.Env) => CandidateStore
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly queue?: Queue<ClipQueueMessage>
  readonly fetchPage?: FetchPage
  readonly now?: () => Date
}

function noticeFromQuery(raw: string | undefined): CandidateNotice | undefined {
  const messages: Record<CandidateNoticeKind, string> = {
    registered: '候補に登録しました',
    duplicate: '同じ記事はすでに候補にあります',
    paywalled: '有料記事と判定したため、読書候補からは除外しました',
    fetch_failed: 'ページを取得できませんでした',
    clipped: '全文の準備を開始しました',
    reused: '完成済みの EPUB を再利用します（OPDSで取得可能）',
    unsendable: '有料または全文を取得できないため送れません',
    clip_failed: '全文の送信に失敗しました。再試行できます',
  }
  if (
    raw !== 'registered' &&
    raw !== 'duplicate' &&
    raw !== 'paywalled' &&
    raw !== 'fetch_failed' &&
    raw !== 'clipped' &&
    raw !== 'reused' &&
    raw !== 'unsendable' &&
    raw !== 'clip_failed'
  ) {
    return undefined
  }
  return { kind: raw, message: messages[raw] }
}

function candidateStoreFor(env: Cloudflare.Env, deps: CandidateHttpDeps): CandidateStore {
  if (deps.candidateStore !== undefined) {
    return deps.candidateStore
  }
  const create = deps.createCandidateStore ?? createD1CandidateStore
  return create(env)
}

function articleStoreFor(env: Cloudflare.Env, deps: CandidateHttpDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  const create = deps.createStore ?? createR2Store
  return create(env)
}

function clipQueueFor(env: Cloudflare.Env, deps: CandidateHttpDeps): Queue<ClipQueueMessage> {
  return deps.queue ?? env.CLIP_QUEUE
}

async function requireCsrf(
  auth: ClipWebAuth,
  presented: string | undefined,
): Promise<Response | null> {
  if (auth.via === 'session' && !(await csrfTokensMatch(presented, auth.session.csrfToken))) {
    return toErrorResponse({ kind: 'csrf_failed' })
  }
  return null
}

async function listedBody(
  env: Cloudflare.Env,
  deps: CandidateHttpDeps,
  pageNumber: number,
  now: () => Date,
) {
  const candidates = candidateStoreFor(env, deps)
  const articles = articleStoreFor(env, deps)
  const listed = await candidates.listListed({
    limit: CANDIDATE_LIST_PAGE_SIZE,
    offset: listOffset(pageNumber),
  })
  const nowMs = now().getTime()
  const publics = await Promise.all(
    listed.items.map((item) => enrichCandidatePublic(item, articles, nowMs)),
  )
  await Promise.all(
    listed.items.map((item, index) => {
      const publicItem = publics[index]
      if (publicItem === undefined) {
        return Promise.resolve()
      }
      return syncCandidateCompletion(item, publicItem, candidates, now())
    }),
  )
  return toCandidateListBodyFromPublic(publics, listed.total, listed.limit, pageNumber)
}

async function readClipSend(c: Context<AppEnv>, json: boolean): Promise<{ regenerate: boolean; csrf: string } | Response> {
  if (json) {
    let regenerate = false
    const raw = await c.req.text().catch(() => '')
    if (raw.trim() !== '') {
      try {
        const body: unknown = JSON.parse(raw)
        if (typeof body === 'object' && body !== null && 'regenerate' in body) {
          regenerate = (body as { regenerate?: unknown }).regenerate === true
        }
      } catch {
        regenerate = false
      }
    }
    return { regenerate, csrf: c.req.header('x-csrf-token') ?? '' }
  }
  try {
    const form = await c.req.parseBody()
    return {
      regenerate: form.regenerate === '1' || form.regenerate === 'true',
      csrf: typeof form.csrf === 'string' ? form.csrf : '',
    }
  } catch {
    return htmlResponse('読書候補', '<p>入力を読み取れませんでした</p>', 400)
  }
}

export function mountCandidateRoutes(app: Hono<AppEnv>, deps: CandidateHttpDeps = {}): void {
  const fetchPage = deps.fetchPage ?? defaultFetchPage
  const now = deps.now ?? (() => new Date())

  app.on('GET', ['/candidates/login', '/candidates/login/'], async (c) => {
    if ((await bearerOk(c)) || (await sessionFrom(c)) !== null) {
      return c.redirect('/candidates', 302)
    }
    return htmlResponse('候補一覧に入る', loginPageHtml())
  })

  app.on('POST', ['/candidates/login', '/candidates/login/'], async (c) => {
    let token = ''
    try {
      const form = await c.req.parseBody()
      token = typeof form.token === 'string' ? form.token.trim() : ''
    } catch {
      return htmlResponse('候補一覧に入る', loginPageHtml('トークンを入力してください'), 400)
    }
    if (!(await clipTokenAuthorized(`Bearer ${token}`, c.env.CLIP_TOKEN))) {
      return htmlResponse('候補一覧に入る', loginPageHtml('トークンが違います'), 401)
    }
    const session = await createCandidateSession(c.env.CLIP_TOKEN)
    return htmlResponse('読書候補', '<p>移動します。</p><p><a href="/candidates">候補一覧</a></p>', 303, {
      location: '/candidates',
      'set-cookie': candidateSessionSetCookie(session, requestIsHttps(c)),
    })
  })

  app.on('POST', ['/candidates/logout', '/candidates/logout/'], async (c) => {
    const auth = await requireClipWebAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    if (auth.via === 'session') {
      let csrf = ''
      try {
        const form = await c.req.parseBody()
        csrf = typeof form.csrf === 'string' ? form.csrf : ''
      } catch {
        csrf = ''
      }
      if (!(await csrfTokensMatch(csrf, auth.session.csrfToken))) {
        return toErrorResponse({ kind: 'csrf_failed' })
      }
    }
    return htmlResponse('候補一覧に入る', loginPageHtml(), 303, {
      location: '/candidates/login',
      'set-cookie': candidateSessionClearCookie(requestIsHttps(c)),
    })
  })

  const list = async (c: Context<AppEnv>) => {
    const auth = await requireClipWebAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const pageNumber = parseListPage(c.req.query('page'))
    const body = await listedBody(c.env, deps, pageNumber, now)
    if (wantsJson(c)) {
      return c.json(body, 200)
    }
    const csrfToken = auth.via === 'session' ? auth.session.csrfToken : ''
    const notice = noticeFromQuery(c.req.query('notice'))
    return htmlResponse(
      '読書候補',
      candidatesPageHtml({
        list: body,
        csrfToken,
        ...(notice === undefined ? {} : { notice }),
      }),
    )
  }
  app.on('GET', ['/candidates', '/candidates/', '/candidates.json', '/candidates.json/'], list)

  app.on('POST', ['/candidates/:id/clip', '/candidates/:id/clip/'], async (c) => {
    const auth = await requireClipWebAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const candidateId = candidateIdParam(c.req.param('id'))
    if (candidateId === null) {
      return json ? toErrorResponse({ kind: 'not_found' }) : htmlResponse('読書候補', '<p>候補が見つかりません</p>', 404)
    }
    const parsed = await readClipSend(c, json)
    if (parsed instanceof Response) {
      return parsed
    }
    const denied = await requireCsrf(auth, parsed.csrf)
    if (denied !== null) {
      return denied
    }
    const sent = await sendCandidateClip({
      candidateId,
      regenerate: parsed.regenerate,
      candidateStore: candidateStoreFor(c.env, deps),
      articleStore: articleStoreFor(c.env, deps),
      queue: clipQueueFor(c.env, deps),
      now,
    })
    if (!sent.ok) {
      if (json) {
        return toErrorResponse(sent.error)
      }
      const notice = sent.error.kind === 'candidate_unsendable' ? 'unsendable' : sent.error.kind === 'queue_failed' ? 'clip_failed' : 'clip_failed'
      if (sent.error.kind === 'not_found') {
        return htmlResponse('読書候補', '<p>候補が見つかりません</p>', 404)
      }
      return htmlResponse('読書候補', '<p>送信できませんでした</p>', 303, {
        location: `/candidates?notice=${notice}`,
      })
    }
    if (json) {
      const status = sent.value.body.deliveryState === 'available' ? 200 : 202
      return c.json(sent.value.body, status)
    }
    const notice = sent.value.reused && sent.value.body.deliveryState === 'available' ? 'reused' : 'clipped'
    return htmlResponse('読書候補', '<p>送信しました</p>', 303, {
      location: `/candidates?notice=${notice}`,
    })
  })

  app.on('POST', ['/candidates', '/candidates/'], async (c) => {
    const auth = await requireClipWebAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    let rawUrl = ''
    let csrf = ''
    if (json) {
      let raw: string
      try {
        raw = await c.req.text()
      } catch {
        return toErrorResponse({ kind: 'invalid_url', url: '' })
      }
      const shareText = parseClipShareText(c.req.header('content-type'), raw)
      if (shareText === null) {
        return toErrorResponse({ kind: 'invalid_url', url: '' })
      }
      rawUrl = shareText
      if (auth.via === 'session' && !(await csrfTokensMatch(c.req.header('x-csrf-token'), auth.session.csrfToken))) {
        return toErrorResponse({ kind: 'csrf_failed' })
      }
    } else {
      try {
        const form = await c.req.parseBody()
        rawUrl = typeof form.url === 'string' ? form.url : ''
        csrf = typeof form.csrf === 'string' ? form.csrf : ''
      } catch {
        return htmlResponse('読書候補', '<p>URL を入力してください</p>', 400)
      }
      if (auth.via === 'session' && !(await csrfTokensMatch(csrf, auth.session.csrfToken))) {
        return toErrorResponse({ kind: 'csrf_failed' })
      }
    }

    const parsed = parseClipUrl({ url: rawUrl })
    if (!parsed.ok) {
      return json
        ? toErrorResponse(parsed.error)
        : htmlResponse('読書候補', '<p>http(s) の URL を指定してください</p>', 400)
    }
    const registered = await registerCandidate(parsed.value, {
      store: candidateStoreFor(c.env, deps),
      fetchPage,
      now,
    })
    if (!registered.ok) {
      return json
        ? toErrorResponse(registered.error)
        : htmlResponse('読書候補', '<p>この URL は取得対象にできません</p>', 400)
    }
    if (json) {
      return c.json(
        toRegisterJson({
          candidate: toCandidatePublic(registered.value.candidate),
          duplicate: registered.value.duplicate,
          notice: registered.value.notice,
        }),
        registered.value.duplicate ? 200 : 201,
      )
    }
    return htmlResponse('読書候補', '<p>登録しました</p>', 303, {
      location: `/candidates?notice=${registered.value.notice.kind}`,
    })
  })
}
