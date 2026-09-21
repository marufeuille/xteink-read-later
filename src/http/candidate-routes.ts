import type { Context, Hono } from 'hono'
import { listOffset, parseListPage, toCandidateListBody, toCandidatePublic } from '../candidates/list'
import { candidatesPageHtml, htmlResponse, loginPageHtml, toRegisterJson } from '../candidates/html'
import { registerCandidate } from '../candidates/register'
import { parseClipUrl } from '../extract/parse-clip-url'
import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import { createD1CandidateStore } from '../store/d1-candidates'
import {
  CANDIDATE_LIST_PAGE_SIZE,
  type AppEnv,
  type CandidateNotice,
  type CandidateNoticeKind,
  type CandidateStore,
  type FetchPage,
} from '../types'
import { clipTokenAuthorized } from './auth'
import {
  candidateSessionClearCookie,
  candidateSessionSetCookie,
  createCandidateSession,
  csrfTokensMatch,
} from './candidate-session'
import { bearerOk, requestIsHttps, requireClipWebAuth, sessionFrom, wantsJson } from './clip-web-auth'
import { parseClipShareText } from './clip-request'
import { toErrorResponse } from './error-response'

export type CandidateHttpDeps = {
  readonly candidateStore?: CandidateStore
  readonly createCandidateStore?: (env: Cloudflare.Env) => CandidateStore
  readonly fetchPage?: FetchPage
  readonly now?: () => Date
}

function noticeFromQuery(raw: string | undefined): CandidateNotice | undefined {
  if (raw !== 'registered' && raw !== 'duplicate' && raw !== 'paywalled' && raw !== 'fetch_failed') {
    return undefined
  }
  const kind: CandidateNoticeKind = raw
  const message =
    kind === 'paywalled'
      ? '有料記事と判定したため、読書候補からは除外しました'
      : kind === 'duplicate'
        ? '同じ記事はすでに候補にあります'
        : kind === 'fetch_failed'
          ? 'ページを取得できませんでした'
          : '候補に登録しました'
  return { kind, message }
}

export function mountCandidateRoutes(app: Hono<AppEnv>, deps: CandidateHttpDeps = {}): void {
  const storeFor = (env: Cloudflare.Env): CandidateStore => {
    if (deps.candidateStore !== undefined) {
      return deps.candidateStore
    }
    const create = deps.createCandidateStore ?? createD1CandidateStore
    return create(env)
  }
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
    const listed = await storeFor(c.env).listListed({
      limit: CANDIDATE_LIST_PAGE_SIZE,
      offset: listOffset(pageNumber),
    })
    const body = toCandidateListBody(listed, pageNumber)
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
      store: storeFor(c.env),
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
