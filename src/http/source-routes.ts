import type { Context, Hono } from 'hono'
import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import { fetchFeed as defaultFetchFeed } from '../feeds/fetch'
import { sourceNoticeMessage, sourcesPageHtml, htmlResponse } from '../feeds/html'
import { isActiveFeedCollection, parseEnabledInput, parseTopicTagsInput } from '../feeds/source-input'
import { resolveSourceUrls } from '../feeds/resolve'
import { createD1FeedSourceStore } from '../store/d1-sources'
import {
  feedSourceIdFromFeedUrl,
  isFeedSourceId,
  isFeedSourceType,
  newFeedRunId,
  toFeedSourcePublic,
  type AppEnv,
  type FeedCollectBody,
  type FeedQueueMessage,
  type FeedSource,
  type FeedSourceStore,
  type FeedSourceType,
  type FetchFeed,
  type FetchPage,
} from '../types'
import { defaultGetAccessIdentity, type GetAccessIdentity } from './access-identity'
import { denyIfCsrfMismatch, presentedCsrf, requireClipWebAuth, wantsJson } from './clip-web-auth'
import { toErrorResponse } from './error-response'

export type SourceHttpDeps = {
  readonly sourceStore?: FeedSourceStore
  readonly createSourceStore?: (env: Cloudflare.Env) => FeedSourceStore
  readonly fetchPage?: FetchPage
  readonly fetchFeed?: FetchFeed
  readonly now?: () => Date
  readonly feedQueue?: Queue<FeedQueueMessage>
  readonly getAccessIdentity?: GetAccessIdentity
}

function storeFor(env: Cloudflare.Env, deps: SourceHttpDeps): FeedSourceStore {
  if (deps.sourceStore !== undefined) {
    return deps.sourceStore
  }
  const create = deps.createSourceStore ?? createD1FeedSourceStore
  return create(env)
}

function queueFor(env: Cloudflare.Env, deps: SourceHttpDeps): Queue<FeedQueueMessage> {
  return deps.feedQueue ?? env.FEED_QUEUE
}

function nowIso(now: () => Date): string {
  return now().toISOString()
}

function emptySourceFields(): Pick<
  FeedSource,
  | 'collectionRunId'
  | 'collectionStatus'
  | 'collectionAttempt'
  | 'collectionErrorCode'
  | 'collectionErrorMessage'
  | 'itemsSeen'
  | 'itemsRegistered'
  | 'itemsDuplicate'
  | 'itemsSkipped'
  | 'lastCollectedAt'
> {
  return {
    collectionRunId: null,
    collectionStatus: null,
    collectionAttempt: 0,
    collectionErrorCode: null,
    collectionErrorMessage: null,
    itemsSeen: 0,
    itemsRegistered: 0,
    itemsDuplicate: 0,
    itemsSkipped: 0,
    lastCollectedAt: null,
  }
}

type SourceForm = {
  readonly name: string
  readonly siteUrl: string
  readonly feedUrl: string
  readonly sourceType: string
  readonly topicTags: unknown
  readonly enabled: unknown
  readonly csrf: string
}

async function readSourceForm(c: Context<AppEnv>, json: boolean): Promise<SourceForm | Response> {
  if (json) {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return toErrorResponse({ kind: 'invalid_url', url: '' })
    }
    if (typeof body !== 'object' || body === null) {
      return toErrorResponse({ kind: 'invalid_url', url: '' })
    }
    const record = body as Record<string, unknown>
    return {
      name: typeof record.name === 'string' ? record.name : '',
      siteUrl: typeof record.siteUrl === 'string' ? record.siteUrl : typeof record.site_url === 'string' ? record.site_url : '',
      feedUrl: typeof record.feedUrl === 'string' ? record.feedUrl : typeof record.feed_url === 'string' ? record.feed_url : '',
      sourceType:
        typeof record.sourceType === 'string'
          ? record.sourceType
          : typeof record.source_type === 'string'
            ? record.source_type
            : '',
      topicTags: record.topicTags ?? record.topic_tags,
      enabled: record.enabled,
      csrf: c.req.header('x-csrf-token') ?? '',
    }
  }
  try {
    const form = await c.req.parseBody()
    return {
      name: typeof form.name === 'string' ? form.name : '',
      siteUrl: typeof form.site_url === 'string' ? form.site_url : '',
      feedUrl: typeof form.feed_url === 'string' ? form.feed_url : '',
      sourceType: typeof form.source_type === 'string' ? form.source_type : '',
      topicTags: typeof form.topic_tags === 'string' ? form.topic_tags : '',
      enabled: form.enabled,
      csrf: typeof form.csrf === 'string' ? form.csrf : '',
    }
  } catch {
    return htmlResponse('情報源', '<p>入力を読み取れませんでした</p>', 400)
  }
}

function invalidTypeResponse(json: boolean): Response {
  return json
    ? toErrorResponse({
        kind: 'invalid_feed',
        reason: '情報源種別は企業ブログ / 投稿サイト / ニュース / キュレーションのいずれかです',
        url: '',
      })
    : htmlResponse('情報源', '<p>情報源種別を選んでください</p>', 400)
}

async function enqueueCollection(
  source: FeedSource,
  store: FeedSourceStore,
  queue: Queue<FeedQueueMessage>,
  now: () => Date,
  nowMs: number,
): Promise<{ readonly source: FeedSource; readonly body: FeedCollectBody } | Response> {
  if (!source.enabled) {
    return toErrorResponse({ kind: 'source_disabled' })
  }
  if (isActiveFeedCollection(source, nowMs) && source.collectionRunId !== null) {
    return {
      source,
      body: { sourceId: source.id, runId: source.collectionRunId, status: 'queued' },
    }
  }
  const runId = newFeedRunId()
  const updated: FeedSource = {
    ...source,
    collectionRunId: runId,
    collectionStatus: 'queued',
    collectionAttempt: 0,
    collectionErrorCode: null,
    collectionErrorMessage: null,
    updatedAt: nowIso(now),
  }
  await store.put(updated)
  try {
    await queue.send({ sourceId: source.id, runId })
  } catch (cause) {
    const failed: FeedSource = {
      ...updated,
      collectionStatus: 'failed',
      collectionErrorCode: 'queue_failed',
      collectionErrorMessage: cause instanceof Error ? cause.message : 'queue send failed',
      updatedAt: nowIso(now),
    }
    await store.put(failed)
    return toErrorResponse({
      kind: 'queue_failed',
      reason: cause instanceof Error ? cause.message : 'queue send failed',
    })
  }
  return { source: updated, body: { sourceId: source.id, runId, status: 'queued' } }
}

export function mountSourceRoutes(app: Hono<AppEnv>, deps: SourceHttpDeps = {}): void {
  const fetchPage = deps.fetchPage ?? defaultFetchPage
  const fetchFeed = deps.fetchFeed ?? defaultFetchFeed
  const now = deps.now ?? (() => new Date())
  const webAuth = (c: Context<AppEnv>) =>
    requireClipWebAuth(c, deps.getAccessIdentity ?? defaultGetAccessIdentity)

  const list = async (c: Context<AppEnv>) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const sources = (await storeFor(c.env, deps).list()).map(toFeedSourcePublic)
    if (wantsJson(c)) {
      return c.json({ sources }, 200)
    }
    const csrfToken = auth.csrfToken
    const notice = sourceNoticeMessage(c.req.query('notice'))
    return htmlResponse(
      '情報源',
      sourcesPageHtml({
        sources,
        csrfToken,
        ...(notice === undefined ? {} : { notice }),
      }),
    )
  }
  app.on('GET', ['/sources', '/sources/', '/sources.json', '/sources.json/'], list)

  app.on('POST', ['/sources/collect', '/sources/collect/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const denied = await denyIfCsrfMismatch(auth, await presentedCsrf(c, json))
    if (denied !== null) {
      return denied
    }
    const store = storeFor(c.env, deps)
    const queue = queueFor(c.env, deps)
    const enabled = await store.listEnabled()
    const runs: FeedCollectBody[] = []
    const failures: { sourceId: FeedSource['id']; error: string }[] = []
    for (const source of enabled) {
      const queued = await enqueueCollection(source, store, queue, now, Date.now())
      if (queued instanceof Response) {
        failures.push({ sourceId: source.id, error: queued.statusText || String(queued.status) })
        continue
      }
      runs.push(queued.body)
    }
    if (json) {
      return c.json({ runs, failures }, 202)
    }
    return htmlResponse('情報源', '<p>収集を予約しました</p>', 303, { location: '/sources?notice=queued' })
  })

  app.on('POST', ['/sources', '/sources/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const form = await readSourceForm(c, json)
    if (form instanceof Response) {
      return form
    }
    const denied = await denyIfCsrfMismatch(auth, form.csrf)
    if (denied !== null) {
      return denied
    }
    const name = form.name.trim()
    if (name.length === 0) {
      return json
        ? toErrorResponse({ kind: 'invalid_url', url: '' })
        : htmlResponse('情報源', '<p>名前を入力してください</p>', 400)
    }
    if (!isFeedSourceType(form.sourceType)) {
      return invalidTypeResponse(json)
    }
    const sourceType: FeedSourceType = form.sourceType
    const resolved = await resolveSourceUrls(
      { siteUrl: form.siteUrl, feedUrl: form.feedUrl },
      { fetchPage, fetchFeed },
    )
    if (!resolved.ok) {
      if (resolved.error.kind === 'invalid_feed' && !json) {
        return htmlResponse(
          '情報源',
          sourcesPageHtml({
            sources: (await storeFor(c.env, deps).list()).map(toFeedSourcePublic),
            csrfToken: auth.csrfToken,
            notice:
              sourceNoticeMessage('feed_missing') ??
              'サイトからフィードを見つけられませんでした。フィード URL を入力してください',
          }),
          400,
        )
      }
      return json || resolved.error.kind !== 'invalid_url'
        ? toErrorResponse(resolved.error)
        : htmlResponse('情報源', '<p>http(s) の URL を指定してください</p>', 400)
    }
    const store = storeFor(c.env, deps)
    const existing = await store.getByFeedUrl(resolved.value.feedUrl)
    if (existing !== null) {
      if (json) {
        return c.json({ id: existing.id, duplicate: true, source: toFeedSourcePublic(existing) }, 200)
      }
      return htmlResponse('情報源', '<p>登録済みです</p>', 303, { location: '/sources?notice=duplicate' })
    }
    const createdAt = nowIso(now)
    const source: FeedSource = {
      id: await feedSourceIdFromFeedUrl(resolved.value.feedUrl),
      name,
      siteUrl: resolved.value.siteUrl,
      feedUrl: resolved.value.feedUrl,
      sourceType,
      topicTags: parseTopicTagsInput(form.topicTags),
      enabled: parseEnabledInput(form.enabled, true),
      ...emptySourceFields(),
      createdAt,
      updatedAt: createdAt,
    }
    await store.put(source)
    if (json) {
      return c.json({ id: source.id, duplicate: false, source: toFeedSourcePublic(source) }, 201)
    }
    return htmlResponse('情報源', '<p>登録しました</p>', 303, { location: '/sources?notice=created' })
  })

  app.on('POST', ['/sources/:id/collect', '/sources/:id/collect/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const id = c.req.param('id')
    if (id === undefined || !isFeedSourceId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const denied = await denyIfCsrfMismatch(auth, await presentedCsrf(c, json))
    if (denied !== null) {
      return denied
    }
    const store = storeFor(c.env, deps)
    const source = await store.getById(id)
    if (source === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const queued = await enqueueCollection(source, store, queueFor(c.env, deps), now, Date.now())
    if (queued instanceof Response) {
      if (!json && queued.status === 409) {
        return htmlResponse('情報源', '<p>停止中です</p>', 303, { location: '/sources?notice=stopped' })
      }
      return queued
    }
    if (json) {
      return c.json(queued.body, 202)
    }
    return htmlResponse('情報源', '<p>収集を予約しました</p>', 303, { location: '/sources?notice=queued' })
  })

  app.on('POST', ['/sources/:id', '/sources/:id/'], async (c) => {
    const auth = await webAuth(c)
    if (auth instanceof Response) {
      return auth
    }
    const json = wantsJson(c)
    const id = c.req.param('id')
    if (id === undefined || !isFeedSourceId(id)) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const form = await readSourceForm(c, json)
    if (form instanceof Response) {
      return form
    }
    const denied = await denyIfCsrfMismatch(auth, form.csrf)
    if (denied !== null) {
      return denied
    }
    const store = storeFor(c.env, deps)
    const existing = await store.getById(id)
    if (existing === null) {
      return toErrorResponse({ kind: 'not_found' })
    }
    const name = form.name.trim() || existing.name
    const sourceTypeRaw = form.sourceType.trim()
    if (sourceTypeRaw.length > 0 && !isFeedSourceType(sourceTypeRaw)) {
      return invalidTypeResponse(json)
    }
    const sourceType = isFeedSourceType(sourceTypeRaw) ? sourceTypeRaw : existing.sourceType
    const siteRaw = form.siteUrl.trim() || existing.siteUrl
    const feedRaw = form.feedUrl.trim() || existing.feedUrl
    const resolved = await resolveSourceUrls({ siteUrl: siteRaw, feedUrl: feedRaw }, { fetchPage, fetchFeed })
    if (!resolved.ok) {
      return json || resolved.error.kind !== 'invalid_url'
        ? toErrorResponse(resolved.error)
        : htmlResponse('情報源', '<p>http(s) の URL を指定してください</p>', 400)
    }
    if (resolved.value.feedUrl !== existing.feedUrl) {
      const taken = await store.getByFeedUrl(resolved.value.feedUrl)
      if (taken !== null && taken.id !== existing.id) {
        return json
          ? c.json({ id: taken.id, duplicate: true, source: toFeedSourcePublic(taken) }, 200)
          : htmlResponse('情報源', '<p>同じフィードはすでにあります</p>', 303, { location: '/sources?notice=duplicate' })
      }
    }
    const updated: FeedSource = {
      ...existing,
      name,
      siteUrl: resolved.value.siteUrl,
      feedUrl: resolved.value.feedUrl,
      sourceType,
      topicTags: form.topicTags === undefined ? existing.topicTags : parseTopicTagsInput(form.topicTags),
      enabled: parseEnabledInput(form.enabled, existing.enabled),
      updatedAt: nowIso(now),
    }
    await store.put(updated)
    if (json) {
      return c.json({ id: updated.id, duplicate: false, source: toFeedSourcePublic(updated) }, 200)
    }
    return htmlResponse('情報源', '<p>更新しました</p>', 303, { location: '/sources?notice=updated' })
  })
}
