import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { DEFAULT_SMOKE_ARTICLE_URL } from '../src/smoke/constants'
import { createMemoryStore } from '../src/store/memory'
import { asArticleId, asClipJobId, asClipRunId, asEpubBytes, parseHttpUrl } from '../src/types'
import {
  basicAuthorization,
  bearerAuthorization,
  TEST_BINDINGS,
  TEST_CLIP_TOKEN,
  TEST_OPDS_PASSWORD,
  TEST_OPDS_USERNAME,
} from './bindings'
import { createFakeQueue } from './fake-queue'

const SMOKE_TOKEN = 'smoke-clip-token-value'
const SMOKE_USER = 'smoke-opds-user'
const SMOKE_PASS = 'smoke-opds-password-value'
const SMOKE_URL = DEFAULT_SMOKE_ARTICLE_URL

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const SMOKE_TOKEN_HASH = sha256Hex(SMOKE_TOKEN)
const SMOKE_BASIC_HASH = sha256Hex(`${SMOKE_USER}:${SMOKE_PASS}`)
const OTHER_URL = 'https://example.com/other-article'
const SMOKE_ID = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const OTHER_ID = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

function smokeEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    ...TEST_BINDINGS,
    SMOKE_CLIP_TOKEN_SHA256: SMOKE_TOKEN_HASH,
    SMOKE_OPDS_BASIC_SHA256: SMOKE_BASIC_HASH,
    SMOKE_ARTICLE_URL: SMOKE_URL,
    ...overrides,
  } as Cloudflare.Env
}

function appWith(envOverrides: Partial<Cloudflare.Env> = {}) {
  const store = createMemoryStore()
  const queue = createFakeQueue()
  const app = createApp({ store, queue })
  const env = smokeEnv({ ...envOverrides, CLIP_QUEUE: queue } as Partial<Cloudflare.Env>)
  return { app, store, queue, env }
}

async function putArticle(
  store: ReturnType<typeof createMemoryStore>,
  id: typeof SMOKE_ID,
  url: string,
  title = '記事',
) {
  const parsed = parseHttpUrl(url)
  if (parsed === null) {
    throw new Error('url')
  }
  await store.put({
    id,
    title,
    author: null,
    publishedAt: null,
    sourceUrl: parsed,
    canonicalUrl: parsed,
    language: 'ja',
    translated: false,
    epub: asEpubBytes(new Uint8Array([1, 2, 3, 4])),
  })
}

describe('smoke credentials', () => {
  it('accepts the smoke token only for the configured article URL', async () => {
    const { app, queue, env } = appWith()
    const accepted = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(SMOKE_TOKEN),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: SMOKE_URL }),
      },
      env,
    )
    expect(accepted.status).toBe(202)
    const body = await accepted.text()
    expect(body).toContain('job_')
    expect(body).not.toContain(SMOKE_TOKEN)
    expect(queue.size).toBe(1)

    const { app: blockedApp, queue: blockedQueue, env: blockedEnv } = appWith()
    const blocked = await blockedApp.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(SMOKE_TOKEN),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: OTHER_URL }),
      },
      blockedEnv,
    )
    expect(blocked.status).toBe(403)
    const blockedBody = await blocked.text()
    expect(blockedBody).not.toContain(OTHER_URL)
    expect(blockedBody).not.toContain(SMOKE_TOKEN)
    expect(blockedBody).not.toContain(SMOKE_URL)
    expect(blockedQueue.size).toBe(0)
  })

  it('rejects a smoke token that does not match the stored hash', async () => {
    const { app, queue, env } = appWith()
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization('wrong-smoke-token'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: SMOKE_URL }),
      },
      env,
    )
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(SMOKE_TOKEN_HASH)
    expect(queue.size).toBe(0)

    const opds = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization(SMOKE_USER, 'wrong-smoke-password') } },
      env,
    )
    expect(opds.status).toBe(401)
    const wrongUser = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization('wrong-smoke-user', SMOKE_PASS) } },
      env,
    )
    expect(wrongUser.status).toBe(401)
  })

  it('keeps production clip access when smoke secrets are set', async () => {
    const { app, queue, env } = appWith()
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(TEST_CLIP_TOKEN),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: OTHER_URL }),
      },
      env,
    )
    expect(response.status).toBe(202)
    expect(queue.size).toBe(1)
  })

  it('does not authorize when smoke secrets are unset, empty, or whitespace', async () => {
    const cases: Array<Partial<Cloudflare.Env>> = [
      { SMOKE_CLIP_TOKEN_SHA256: undefined as unknown as string },
      { SMOKE_CLIP_TOKEN_SHA256: '' },
      { SMOKE_CLIP_TOKEN_SHA256: '   ' },
      { SMOKE_CLIP_TOKEN_SHA256: SMOKE_TOKEN },
      { SMOKE_CLIP_TOKEN_SHA256: 'abcd' },
    ]
    for (const overrides of cases) {
      const { app, queue, env } = appWith(overrides)
      const response = await app.request(
        '/clip',
        {
          method: 'POST',
          headers: {
            authorization: bearerAuthorization(SMOKE_TOKEN),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ url: SMOKE_URL }),
        },
        env,
      )
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(SMOKE_TOKEN)
      expect(queue.size).toBe(0)

      const production = await app.request(
        '/clip',
        {
          method: 'POST',
          headers: {
            authorization: bearerAuthorization(TEST_CLIP_TOKEN),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ url: OTHER_URL }),
        },
        env,
      )
      expect(production.status).toBe(202)

      const blank = await app.request(
        '/clip',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer ',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ url: SMOKE_URL }),
        },
        env,
      )
      expect(blank.status).toBe(401)
    }
  })

  it('rejects smoke clip when the article URL is unset', async () => {
    const { app, queue, env } = appWith({ SMOKE_ARTICLE_URL: '' })
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(SMOKE_TOKEN),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: SMOKE_URL }),
      },
      env,
    )
    expect(response.status).toBe(403)
    expect(queue.size).toBe(0)
  })

  it('limits smoke job reads, downloads, and deletes to the smoke article', async () => {
    const { app, store, env } = appWith()
    await putArticle(store, SMOKE_ID, SMOKE_URL, '[smoke] デプロイ確認')
    await putArticle(store, OTHER_ID, OTHER_URL, '本番の長い記事タイトル')
    const smokeUrl = parseHttpUrl(SMOKE_URL)
    const otherUrl = parseHttpUrl(OTHER_URL)
    if (smokeUrl === null || otherUrl === null) {
      throw new Error('url')
    }
    await store.putJob({
      jobId: asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      runId: asClipRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      sourceUrl: smokeUrl,
      status: 'queued',
      articleId: null,
      error: null,
      attempt: 0,
      stages: [],
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    })
    await store.putJob({
      jobId: asClipJobId('job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      runId: asClipRunId('run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      sourceUrl: otherUrl,
      status: 'queued',
      articleId: null,
      error: null,
      attempt: 0,
      stages: [],
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    })

    const smokeJob = await app.request(
      '/clip/jobs/job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      { headers: { authorization: bearerAuthorization(SMOKE_TOKEN) } },
      env,
    )
    expect(smokeJob.status).toBe(200)
    const otherJob = await app.request(
      '/clip/jobs/job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      { headers: { authorization: bearerAuthorization(SMOKE_TOKEN) } },
      env,
    )
    expect(otherJob.status).toBe(404)
    expect(await otherJob.text()).not.toContain(OTHER_URL)

    const smokeBasic = { authorization: basicAuthorization(SMOKE_USER, SMOKE_PASS) }
    const catalog = await app.request('https://read.example.com/opds', { headers: smokeBasic }, env)
    expect(catalog.status).toBe(200)
    expect(await catalog.text()).not.toContain('本番の長い記事タイトル')
    const shelf = await app.request('https://read.example.com/opds/clip', { headers: smokeBasic }, env)
    expect(shelf.status).toBe(200)
    const shelfXml = await shelf.text()
    const datePath = /href="https:\/\/read\.example\.com(\/opds\/clip\/\d{4}-\d{2}-\d{2})"/.exec(shelfXml)?.[1]
    expect(datePath).toBeTruthy()
    const day = await app.request(`https://read.example.com${datePath}`, { headers: smokeBasic }, env)
    expect(day.status).toBe(200)
    const dayXml = await day.text()
    expect(dayXml).toContain(SMOKE_ID)
    expect(dayXml).toContain('[smoke] デプロイ確認')
    expect(dayXml).not.toContain(OTHER_ID)
    expect(dayXml).not.toContain(OTHER_URL)
    expect(dayXml).not.toContain('本番の長い記事タイトル')

    const productionDay = await app.request(
      `https://read.example.com${datePath}`,
      { headers: { authorization: basicAuthorization(TEST_OPDS_USERNAME, TEST_OPDS_PASSWORD) } },
      env,
    )
    expect(productionDay.status).toBe(200)
    const productionXml = await productionDay.text()
    expect(productionXml).toContain(SMOKE_ID)
    expect(productionXml).toContain(OTHER_ID)
    expect(productionXml).toContain('本番の長い記事タイトル')

    const ownEpub = await app.request(
      `/opds/download/${SMOKE_ID}.epub`,
      { headers: { authorization: basicAuthorization(SMOKE_USER, SMOKE_PASS) } },
      env,
    )
    expect(ownEpub.status).toBe(200)
    const otherEpub = await app.request(
      `/articles/${OTHER_ID}/book.epub`,
      { headers: { authorization: basicAuthorization(SMOKE_USER, SMOKE_PASS) } },
      env,
    )
    expect(otherEpub.status).toBe(404)
    expect(await store.getMeta(OTHER_ID)).not.toBeNull()

    const removedOther = await app.request(
      `/articles/${OTHER_ID}`,
      { method: 'DELETE', headers: { authorization: bearerAuthorization(SMOKE_TOKEN) } },
      env,
    )
    expect(removedOther.status).toBe(404)
    expect(await store.getMeta(OTHER_ID)).not.toBeNull()

    const removed = await app.request(
      `/articles/${SMOKE_ID}`,
      { method: 'DELETE', headers: { authorization: bearerAuthorization(SMOKE_TOKEN) } },
      env,
    )
    expect(removed.status).toBe(200)
    expect(await store.getMeta(SMOKE_ID)).toBeNull()
    expect(await store.getMeta(OTHER_ID)).not.toBeNull()
  })

  it('does not let unset smoke OPDS secrets or the smoke token into other routes', async () => {
    const { app, store, env } = appWith({
      SMOKE_OPDS_BASIC_SHA256: '   ',
    })
    await putArticle(store, OTHER_ID, OTHER_URL)
    const opds = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization(SMOKE_USER, SMOKE_PASS) } },
      env,
    )
    expect(opds.status).toBe(401)
    expect(await opds.text()).not.toContain(SMOKE_PASS)

    const production = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization(TEST_OPDS_USERNAME, TEST_OPDS_PASSWORD) } },
      env,
    )
    expect(production.status).toBe(200)

    const candidates = await app.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization(SMOKE_TOKEN) } },
      env,
    )
    expect(candidates.status).toBe(401)
    const recent = await app.request(
      '/clip/recent',
      {
        headers: {
          authorization: bearerAuthorization(SMOKE_TOKEN),
          accept: 'application/json',
        },
      },
      env,
    )
    expect(recent.status).toBe(401)
    const books = await app.request(
      '/books',
      {
        method: 'POST',
        headers: {
          authorization: bearerAuthorization(SMOKE_TOKEN),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: '本' }),
      },
      env,
    )
    expect(books.status).toBe(401)
  })
})
