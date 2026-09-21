import type { Context, Hono } from 'hono'
import { sendCandidateClip } from '../candidates/clip'
import { enrichCandidatePublic, syncCandidateCompletion, candidateIdParam } from '../candidates/delivery'
import { listOffset, toCandidateListBodyFromPublic, toCandidatePublic } from '../candidates/list'
import { candidatesLocation, parseCandidateListFilters, parseListPage } from '../candidates/list-filter'
import { candidatesPageHtml, htmlResponse, toRegisterJson } from '../candidates/html'
import { reevaluateCandidate } from '../candidates/recommend'
import { registerCandidate } from '../candidates/register'
import { parseClipUrl } from '../extract/parse-clip-url'
import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import { createD1CandidateStore } from '../store/d1-candidates'
import { createR2Store } from '../store/r2'
import {
  CANDIDATE_LIST_PAGE_SIZE,
  type AppEnv,
  type ArticleStore,
  type CandidateListFilters,
  type CandidateNotice,
  type CandidateNoticeKind,
  type CandidateStore,
  type ClipQueueMessage,
  type CreateArticleStore,
  type EvaluateSystemOne,
  type FetchPage,
} from '../types'
import { defaultGetAccessIdentity, type GetAccessIdentity } from './access-identity'
import {
  ACCESS_LOGOUT_PATH,
  denyIfCsrfMismatch,
  presentedCsrf,
  requireClipWebAuth,
  wantsJson,
} from './clip-web-auth'
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
  readonly evaluateRecommend?: EvaluateSystemOne
  readonly getAccessIdentity?: GetAccessIdentity
}

const NOTICE_MESSAGES: Record<CandidateNoticeKind, string> = {
  registered: '候補に登録しました',
  duplicate: '同じ記事はすでに候補にあります',
  paywalled: '有料記事と判定したため、読書候補からは除外しました',
  fetch_failed: 'ページを取得できませんでした',
  clipped: '全文の準備を開始しました',
  reused: '完成済みの EPUB を再利用します（OPDSで取得可能）',
  unsendable: '有料または全文を取得できないため送れません',
  clip_failed: '全文の送信に失敗しました。再試行できます',
  rejudged: 'おすすめ度を判定しました',
}

function noticeFromQuery(raw: string | undefined): CandidateNotice | undefined {
  if (raw === undefined || !Object.hasOwn(NOTICE_MESSAGES, raw)) {
    return undefined
  }
  const kind = raw as CandidateNoticeKind
  return { kind, message: NOTICE_MESSAGES[kind] }
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

async function listedBody(
  env: Cloudflare.Env,
  deps: CandidateHttpDeps,
  pageNumber: number,
  filters: CandidateListFilters,
  now: () => Date,
) {
  const candidates = candidateStoreFor(env, deps)
  const articles = articleStoreFor(env, deps)
  const listed = await candidates.listListed({
    limit: CANDIDATE_LIST_PAGE_SIZE,
    offset: listOffset(pageNumber),
    title: filters.title,
    grade: filters.grade,
    outlet: filters.outlet,
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
  return toCandidateListBodyFromPublic(publics, listed.total, listed.limit, pageNumber, filters, listed.outlets)
}

function htmlListLocation(
  c: Context<AppEnv>,
  notice: CandidateNoticeKind,
  returnTo?: string,
): string {
  return candidatesLocation({
    returnTo,
    referer: c.req.header('referer'),
    notice,
  })
}

async function readActionFlag(
  c: Context<AppEnv>,
  json: boolean,
  field: 'force' | 'regenerate',
): Promise<{ flag: boolean; csrf: string; returnTo: string } | Response> {
  if (json) {
    let flag = false
    const raw = await c.req.text().catch(() => '')
    if (raw.trim() !== '') {
      try {
        const body: unknown = JSON.parse(raw)
        if (typeof body === 'object' && body !== null && field in body) {
          flag = (body as Record<string, unknown>)[field] === true
        }
      } catch {
        flag = false
      }
    }
    return { flag, csrf: c.req.header('x-csrf-token') ?? '', returnTo: '' }
  }
  try {
    const form = await c.req.parseBody()
    return {
      flag: form[field] === '1' || form[field] === 'true',
      csrf: typeof form.csrf === 'string' ? form.csrf : '',
      returnTo: typeof form.return_to === 'string' ? form.return_to : '',
    }
  } catch {
    return htmlResponse('読書候補', '<p>入力を読み取れませんでした</p>', 400)
  }
}

export function mountCandidateRoutes(app: Hono<AppEnv>, deps: CandidateHttpDeps = {}): void {
  const fetchPage = deps.fetchPage ?? defaultFetchPage
  const now = deps.now ?? (() => new Date())
  const webAuth = (c: Context<AppEnv>) =>
    requireClipWebAuth(c, deps.getAccessIdentity ?? defaultGetAccessIdentity)

  app.on('GET', ['/candidates/login', '/candidates/login/'], (c) => c.redirect('/candidates', 302))

  app.on('POST', ['/candidates/logout', '/candidates/logout/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const denied = await denyIfCsrfMismatch(auth, await presentedCsrf(c, false))
    if (denied !== null) {
      return denied
    }
    return htmlResponse('出る', '<p>出ます</p>', 303, {
      location: ACCESS_LOGOUT_PATH,
    })
  })

  const list = async (c: Context<AppEnv>) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const query = c.req.query()
    const pageNumber = parseListPage(query.page)
    const filters = parseCandidateListFilters(query)
    const body = await listedBody(c.env, deps, pageNumber, filters, now)
    if (wantsJson(c)) {
      return c.json(body, 200)
    }
    const csrfToken = auth.csrfToken
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
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const candidateId = candidateIdParam(c.req.param('id'))
    if (candidateId === null) {
      return json ? toErrorResponse({ kind: 'not_found' }) : htmlResponse('読書候補', '<p>候補が見つかりません</p>', 404)
    }
    const parsed = await readActionFlag(c, json, 'regenerate')
    if (parsed instanceof Response) {
      return parsed
    }
    const denied = await denyIfCsrfMismatch(auth, parsed.csrf)
    if (denied !== null) {
      return denied
    }
    const sent = await sendCandidateClip({
      candidateId,
      regenerate: parsed.flag,
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
        location: htmlListLocation(c, notice, parsed.returnTo),
      })
    }
    if (json) {
      const status = sent.value.body.deliveryState === 'available' ? 200 : 202
      return c.json(sent.value.body, status)
    }
    const notice = sent.value.reused && sent.value.body.deliveryState === 'available' ? 'reused' : 'clipped'
    return htmlResponse('読書候補', '<p>送信しました</p>', 303, {
      location: htmlListLocation(c, notice, parsed.returnTo),
    })
  })

  app.on('POST', ['/candidates/:id/recommend', '/candidates/:id/recommend/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const candidateId = candidateIdParam(c.req.param('id'))
    if (candidateId === null) {
      return json ? toErrorResponse({ kind: 'not_found' }) : htmlResponse('読書候補', '<p>候補が見つかりません</p>', 404)
    }
    const parsed = await readActionFlag(c, json, 'force')
    if (parsed instanceof Response) {
      return parsed
    }
    const denied = await denyIfCsrfMismatch(auth, parsed.csrf)
    if (denied !== null) {
      return denied
    }
    const judged = await reevaluateCandidate({
      candidateId,
      force: parsed.flag,
      store: candidateStoreFor(c.env, deps),
      fetchPage,
      now,
      jevDeps: { OPENROUTER_API_KEY: c.env.OPENROUTER_API_KEY },
      ...(deps.evaluateRecommend === undefined ? {} : { evaluate: deps.evaluateRecommend }),
    })
    if (!judged.ok) {
      return json
        ? toErrorResponse(judged.error)
        : htmlResponse('読書候補', '<p>候補が見つかりません</p>', 404)
    }
    if (json) {
      const publicItem = await enrichCandidatePublic(
        judged.value.candidate,
        articleStoreFor(c.env, deps),
        now().getTime(),
      )
      return c.json(
        {
          candidateId: judged.value.candidate.id,
          reused: judged.value.reused,
          candidate: publicItem,
        },
        200,
      )
    }
    return htmlResponse('読書候補', '<p>判定しました</p>', 303, {
      location: htmlListLocation(c, 'rejudged', parsed.returnTo),
    })
  })

  app.on('POST', ['/candidates', '/candidates/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    let rawUrl = ''
    let csrf = ''
    let returnTo = ''
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
      csrf = c.req.header('x-csrf-token') ?? ''
    } else {
      try {
        const form = await c.req.parseBody()
        rawUrl = typeof form.url === 'string' ? form.url : ''
        csrf = typeof form.csrf === 'string' ? form.csrf : ''
        returnTo = typeof form.return_to === 'string' ? form.return_to : ''
      } catch {
        return htmlResponse('読書候補', '<p>URL を入力してください</p>', 400)
      }
    }
    const denied = await denyIfCsrfMismatch(auth, csrf)
    if (denied !== null) {
      return denied
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
      jevDeps: { OPENROUTER_API_KEY: c.env.OPENROUTER_API_KEY },
      ...(deps.evaluateRecommend === undefined ? {} : { evaluateRecommend: deps.evaluateRecommend }),
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
      location: htmlListLocation(c, registered.value.notice.kind, returnTo),
    })
  })
}
