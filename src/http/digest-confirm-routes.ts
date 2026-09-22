import type { Context, Hono } from 'hono'
import { candidateClipBlockReason, sendCandidateClip } from '../candidates/clip'
import {
  digestConfirmPath,
  verifyDigestQrToken,
} from '../digest/confirm-link'
import {
  digestConfirmRejectedHtml,
  digestConfirmResultHtml,
  digestConfirmUnsendableHtml,
  digestConfirmViewHtml,
} from '../digest/confirm-page'
import { htmlResponse } from '../feeds/html'
import { logDigestConfirm } from '../log'
import { createD1CandidateStore } from '../store/d1-candidates'
import { createR2Store } from '../store/r2'
import {
  isCandidateId,
  type AppEnv,
  type ArticleStore,
  type CandidateStore,
  type ClipQueueMessage,
} from '../types'
import type { CandidateHttpDeps } from './candidate-routes'

const NO_STORE = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const

const CONFIRM_PATHS = [
  '/digest/send/:candidateId/:expires/:token',
  '/digest/send/:candidateId/:expires/:token/',
] as const

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

function confirmLog(input: {
  readonly candidateId: string
  readonly result: Parameters<typeof logDigestConfirm>[0]['result']
  readonly reason?: Parameters<typeof logDigestConfirm>[0]['reason']
}): void {
  logDigestConfirm({
    result: input.result,
    ...(isCandidateId(input.candidateId) ? { candidateId: input.candidateId } : {}),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  })
}

export function mountDigestConfirmRoutes(app: Hono<AppEnv>, deps: CandidateHttpDeps = {}): void {
  const now = deps.now ?? (() => new Date())

  const handle = async (c: Context<AppEnv>, method: 'GET' | 'POST') => {
    const candidateId = c.req.param('candidateId') ?? ''
    const expires = c.req.param('expires') ?? ''
    const token = c.req.param('token') ?? ''
    const nowMs = now().getTime()
    const verified = await verifyDigestQrToken({
      secret: c.env.CLIP_TOKEN,
      candidateId,
      expiresAt: expires,
      token,
      nowMs,
    })
    if (!verified.ok) {
      confirmLog({ candidateId, result: 'rejected', reason: verified.reason })
      const rejected = digestConfirmRejectedHtml(verified.reason)
      return htmlResponse(rejected.title, rejected.body, 403, NO_STORE)
    }

    const candidates = candidateStoreFor(c.env, deps)
    const articles = articleStoreFor(c.env, deps)
    const candidate = await candidates.getById(verified.candidateId)
    if (candidate === null) {
      confirmLog({ candidateId: verified.candidateId, result: 'rejected', reason: 'not_found' })
      return htmlResponse('記事が見つかりません', '<h1>記事が見つかりません</h1>', 404, NO_STORE)
    }

    const blocked = candidateClipBlockReason(candidate)
    if (blocked !== null) {
      confirmLog({ candidateId: candidate.id, result: 'unsendable', reason: blocked })
      return htmlResponse(
        '送れません',
        digestConfirmUnsendableHtml({ title: candidate.title, reason: blocked }),
        200,
        NO_STORE,
      )
    }

    if (method === 'GET') {
      confirmLog({ candidateId: candidate.id, result: 'view' })
      return htmlResponse(
        '全文を送る',
        digestConfirmViewHtml({
          title: candidate.title,
          action: digestConfirmPath(verified.candidateId, verified.expiresAt, token),
        }),
        200,
        NO_STORE,
      )
    }

    const sent = await sendCandidateClip({
      candidateId: candidate.id,
      regenerate: false,
      candidateStore: candidates,
      articleStore: articles,
      queue: clipQueueFor(c.env, deps),
      now: () => new Date(nowMs),
    })
    if (!sent.ok) {
      if (sent.error.kind === 'not_found') {
        confirmLog({ candidateId: candidate.id, result: 'rejected', reason: 'not_found' })
        return htmlResponse('記事が見つかりません', '<h1>記事が見つかりません</h1>', 404, NO_STORE)
      }
      if (sent.error.kind === 'candidate_unsendable') {
        confirmLog({ candidateId: candidate.id, result: 'unsendable', reason: sent.error.reason })
        return htmlResponse(
          '送れません',
          digestConfirmUnsendableHtml({ title: candidate.title, reason: sent.error.reason }),
          200,
          NO_STORE,
        )
      }
      confirmLog({ candidateId: candidate.id, result: 'failed', reason: 'queue_failed' })
      return htmlResponse('送信に失敗しました', '<h1>送信に失敗しました</h1><p>しばらくしてからもう一度押してください。</p>', 503, NO_STORE)
    }

    const kind = confirmKind(sent.value.reused, sent.value.body.deliveryState)
    confirmLog({
      candidateId: candidate.id,
      result: kind === 'queued' ? 'queued' : 'reused',
    })
    return htmlResponse(
      '全文を送る',
      digestConfirmResultHtml({ title: candidate.title, kind }),
      200,
      NO_STORE,
    )
  }

  app.on('GET', [...CONFIRM_PATHS], (c) => handle(c, 'GET'))
  app.on('POST', [...CONFIRM_PATHS], (c) => handle(c, 'POST'))
}

function confirmKind(
  reused: boolean,
  deliveryState: 'preparing' | 'available' | 'unsent' | 'failed',
): 'reused' | 'preparing' | 'queued' {
  if (!reused) {
    return 'queued'
  }
  return deliveryState === 'available' ? 'reused' : 'preparing'
}
