import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { unevaluatedRecommendation } from '../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryStore } from '../src/store/memory'
import { CANDIDATE_LIST_PAGE_SIZE, asCandidateId, err, ok, parseHttpUrl, type EvaluateSystemOne, type FetchPage } from '../src/types'
import { bearerAuthorization, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'
import { createFakeQueue } from './fake-queue'

const fixtures = dirname(fileURLToPath(import.meta.url))

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function fetchHtml(pages: Record<string, string>): FetchPage {
  return async (url) => {
    const body = pages[url]
    if (body === undefined) {
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    }
    return ok({
      requestedUrl: url,
      finalUrl: url,
      contentType: 'text/html',
      html: body,
    })
  }
}

function appWith(fetchPage: FetchPage = fetchHtml({}), evaluateRecommend?: EvaluateSystemOne) {
  const candidateStore = createMemoryCandidateStore()
  const queue = createFakeQueue()
  const app = createApp({
    store: createMemoryStore(),
    queue,
    candidateStore,
    fetchPage,
    ...(evaluateRecommend === undefined ? {} : { evaluateRecommend }),
  })
  const env = {
    ...TEST_BINDINGS,
    CLIP_QUEUE: queue,
    ...(evaluateRecommend === undefined ? {} : { OPENROUTER_API_KEY: 'or-test' }),
  } as Cloudflare.Env
  return { app, candidateStore, env }
}

function csrfFrom(body: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(body)
  if (match?.[1] === undefined) {
    throw new Error('missing csrf')
  }
  return match[1]
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = /^(xr_candidates=[^;]+)/.exec(header)
  if (match?.[1] === undefined) {
    throw new Error(`missing session cookie: ${header}`)
  }
  return match[1]
}

describe('candidate HTTP auth', () => {
  it('rejects unauthenticated JSON writes and redirects HTML list to login', async () => {
    const { app, env } = appWith()
    const json = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/a' }),
      },
      env,
    )
    expect(json.status).toBe(401)
    expect(await json.text()).not.toContain(TEST_CLIP_TOKEN)

    const listed = await app.request('/candidates.json', { headers: { accept: 'application/json' } }, env)
    expect(listed.status).toBe(401)

    const htmlGet = await app.request('/candidates', {}, env)
    expect(htmlGet.status).toBe(302)
    expect(htmlGet.headers.get('location')).toBe('/candidates/login')
  })

  it('does not embed CLIP_TOKEN in the login or list HTML', async () => {
    const { app, env } = appWith(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
    )
    const login = await app.request('/candidates/login', {}, env)
    expect(await login.text()).not.toContain(TEST_CLIP_TOKEN)

    const entered = await app.request(
      '/candidates/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_CLIP_TOKEN }).toString(),
      },
      env,
    )
    expect(entered.status).toBe(303)
    const cookie = sessionCookie(entered)
    expect(cookie).not.toContain(TEST_CLIP_TOKEN)
    const list = await app.request('/candidates', { headers: { cookie } }, env)
    const listHtml = await list.text()
    expect(listHtml).not.toContain(TEST_CLIP_TOKEN)
    expect(listHtml).toContain('Asia/Tokyo')
  })

  it('rejects cookie POSTs without a matching CSRF token', async () => {
    const { app, env } = appWith(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
    )
    const entered = await app.request(
      '/candidates/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_CLIP_TOKEN }).toString(),
      },
      env,
    )
    const cookie = sessionCookie(entered)
    const denied = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url: 'https://example.com/ja/workers-cpu', csrf: 'nope' }).toString(),
      },
      env,
    )
    expect(denied.status).toBe(403)
  })
})

describe('candidate JSON API', () => {
  it('registers with Bearer, returns duplicates, and leaves POST /clip queued', async () => {
    const fetchPage = fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') })
    const { app, env } = appWith(fetchPage)
    const created = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      duplicate: boolean
      candidate: { title: string; listingState: string; fullTextState: string }
      notice: { kind: string }
    }
    expect(createdBody.duplicate).toBe(false)
    expect(createdBody.candidate.title).toBe('Cloudflare Workers の CPU 制限')
    expect(createdBody.candidate.listingState).toBe('listed')
    expect(createdBody.candidate.fullTextState).toBe('confirmed_free')
    expect(createdBody.notice.kind).toBe('registered')

    const duplicate = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    expect(duplicate.status).toBe(200)
    const duplicateBody = (await duplicate.json()) as { duplicate: boolean; notice: { kind: string } }
    expect(duplicateBody.duplicate).toBe(true)
    expect(duplicateBody.notice.kind).toBe('duplicate')

    const clip = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    expect(clip.status).toBe(202)
    const clipBody = (await clip.json()) as { status: string }
    expect(clipBody.status).toBe('queued')
  })

  it('returns paywalled notice and omits the article from the list', async () => {
    const { app, env } = appWith(
      fetchHtml({ 'https://paywall.example.com/essay': html('candidate-paywall.html') }),
    )
    const created = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({ url: 'https://paywall.example.com/essay' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const body = (await created.json()) as {
      notice: { kind: string; message: string }
      candidate: { listingState: string; fullTextState: string }
    }
    expect(body.notice.kind).toBe('paywalled')
    expect(body.notice.message).toContain('有料')
    expect(body.candidate.listingState).toBe('excluded')
    expect(body.candidate.fullTextState).toBe('unavailable')

    const listed = await app.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization() } },
      env,
    )
    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as { total: number; groups: unknown[] }
    expect(listBody.total).toBe(0)
  })

  it('pages listed candidates and groups unknown published dates separately', async () => {
    const pages: Record<string, string> = {
      'https://example.com/ja/workers-cpu': html('ja-tech.html'),
      'https://notes.example.com/undated': html('candidate-no-date.html'),
    }
    const { app, env } = appWith(fetchHtml(pages))
    await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://notes.example.com/undated' }),
      },
      env,
    )
    const listed = await app.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization() } },
      env,
    )
    const body = (await listed.json()) as {
      timezone: string
      timezoneNote: string
      pageSize: number
      total: number
      groups: { date: string | null; label: string; items: { publishedAt: string | null }[] }[]
    }
    expect(body.timezone).toBe('Asia/Tokyo')
    expect(body.timezoneNote).toContain('UTC+9')
    expect(body.pageSize).toBe(CANDIDATE_LIST_PAGE_SIZE)
    expect(body.total).toBe(2)
    expect(body.groups.some((group) => group.date === null && group.label === '公開日不明')).toBe(true)
    const unknown = body.groups.find((group) => group.date === null)
    expect(unknown?.items.every((item) => item.publishedAt === null)).toBe(true)
  })

  it('pages the JSON list', async () => {
    const { app, candidateStore, env } = appWith()
    const now = '2026-09-21T00:00:00.000Z'
    for (let i = 0; i < 21; i += 1) {
      const url = parseHttpUrl(`https://example.com/p/${i}`)
      if (url === null) {
        throw new Error('url')
      }
      await candidateStore.put({
        id: asCandidateId(`cand_${i.toString().padStart(32, '0')}`),
        canonicalUrl: url,
        sourceUrl: url,
        title: `Article ${i}`,
        outlet: 'Example',
        publishedAt: '2026-09-21T00:00:00.000Z',
        discoveredAt: now,
        fetchStatus: 'fetched',
        listingState: 'listed',
        exclusionReason: null,
        fullTextState: 'unconfirmed',
        completedArticleId: null,
        clipJobId: null,
        clipRunId: null,
        selectedAt: null,
        recommendation: unevaluatedRecommendation(),
        createdAt: now,
        updatedAt: now,
      })
    }
    const page1 = await app.request(
      '/candidates.json',
      { headers: { authorization: bearerAuthorization() } },
      env,
    )
    const page2 = await app.request(
      '/candidates.json?page=2',
      { headers: { authorization: bearerAuthorization() } },
      env,
    )
    const first = (await page1.json()) as { total: number; groups: { items: unknown[] }[] }
    const second = (await page2.json()) as { page: number; groups: { items: unknown[] }[] }
    expect(first.total).toBe(21)
    expect(first.groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(20)
    expect(second.page).toBe(2)
    expect(second.groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(1)
  })
})

describe('candidate HTML form', () => {
  it('accepts a cookie session with CSRF and shows fetch failure state', async () => {
    const { app, env } = appWith(async (url) => err({ kind: 'fetch_failed', url, reason: 'HTTP 502' }))
    const entered = await app.request(
      '/candidates/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_CLIP_TOKEN }).toString(),
      },
      env,
    )
    const cookie = sessionCookie(entered)
    const formPage = await app.request('/candidates', { headers: { cookie } }, env)
    const csrf = csrfFrom(await formPage.text())
    const submitted = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url: 'https://down.example.com/a', csrf }).toString(),
      },
      env,
    )
    expect(submitted.status).toBe(303)
    expect(submitted.headers.get('location')).toContain('notice=fetch_failed')
    const listed = await app.request(
      submitted.headers.get('location') ?? '/candidates',
      { headers: { cookie } },
      env,
    )
    const listedHtml = await listed.text()
    expect(listedHtml).toContain('取得失敗')
    expect(listedHtml).not.toContain('本文取得済み')
    expect(listedHtml).not.toContain(TEST_CLIP_TOKEN)
  })

  it('rejects clip POSTs without CSRF and accepts a session send', async () => {
    const { app, env } = appWith(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
    )
    const entered = await app.request(
      '/candidates/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_CLIP_TOKEN }).toString(),
      },
      env,
    )
    const cookie = sessionCookie(entered)
    const created = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    const id = ((await created.json()) as { id: string }).id
    const denied = await app.request(
      `/candidates/${id}/clip`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: 'nope' }).toString(),
      },
      env,
    )
    expect(denied.status).toBe(403)

    const formPage = await app.request('/candidates', { headers: { cookie } }, env)
    const csrf = csrfFrom(await formPage.text())
    const sent = await app.request(
      `/candidates/${id}/clip`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf }).toString(),
      },
      env,
    )
    expect(sent.status).toBe(303)
    expect(sent.headers.get('location')).toContain('notice=clipped')
  })
})

describe('candidate recommendation HTTP', () => {
  const evaluate: EvaluateSystemOne = async () => ({
    ok: true,
    value: {
      model: 'jev-1.13.0',
      answers: {
        recommendation: { type: 'choice', choice: 'related', confidence: 0.88, probabilities: { related: 0.88 } },
        de_relevant: { type: 'noul', noul: 0.7 },
        has_concreteness: { type: 'noul', noul: 0.6 },
        has_verification: { type: 'noul', noul: 0.1 },
      },
      usage: { inputTokens: 200, outputTokens: 12 },
    },
  })

  it('shows recommendation on the list and keeps failed judgments visible', async () => {
    const { app, env } = appWith(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
      evaluate,
    )
    const created = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      candidate: { listingState: string; recommendation: { status: string; grade: string | null } }
    }
    expect(createdBody.candidate.listingState).toBe('listed')
    expect(createdBody.candidate.recommendation).toEqual({
      status: 'evaluated',
      grade: 'related',
      reasons: ['de_relevant', 'has_concreteness'],
      evaluatedAt: expect.any(String),
    })

    const listed = await app.request('/candidates.json', { headers: { authorization: bearerAuthorization() } }, env)
    const listBody = (await listed.json()) as {
      groups: { items: { recommendation: { status: string; grade: string | null } }[] }[]
    }
    expect(listBody.groups[0]?.items[0]?.recommendation.grade).toBe('related')

    const entered = await app.request(
      '/candidates/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_CLIP_TOKEN }).toString(),
      },
      env,
    )
    const listHtml = await app.request('/candidates', { headers: { cookie: sessionCookie(entered) } }, env)
    const page = await listHtml.text()
    expect(page).toContain('関連あり')
    expect(page).toContain('DE関連')
    expect(page).toContain('再判定')
    expect(page).not.toContain(TEST_CLIP_TOKEN)
  })

  it('rejects unauthenticated recommend POSTs and CSRF mismatches', async () => {
    const { app, env } = appWith(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
      evaluate,
    )
    const created = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    const id = ((await created.json()) as { id: string }).id
    const unauth = await app.request(
      `/candidates/${id}/recommend`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    )
    expect(unauth.status).toBe(401)

    const entered = await app.request(
      '/candidates/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: TEST_CLIP_TOKEN }).toString(),
      },
      env,
    )
    const cookie = sessionCookie(entered)
    const denied = await app.request(
      `/candidates/${id}/recommend`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: 'nope' }).toString(),
      },
      env,
    )
    expect(denied.status).toBe(403)
  })

  it('re-evaluates on POST /candidates/:id/recommend', async () => {
    const { app, env } = appWith(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
      evaluate,
    )
    const created = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ url: 'https://example.com/ja/workers-cpu' }),
      },
      env,
    )
    const id = ((await created.json()) as { id: string }).id
    const judged = await app.request(
      `/candidates/${id}/recommend`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: bearerAuthorization() },
        body: JSON.stringify({ force: true }),
      },
      env,
    )
    expect(judged.status).toBe(200)
    const body = (await judged.json()) as { reused: boolean; candidate: { recommendation: { grade: string | null } } }
    expect(body.reused).toBe(false)
    expect(body.candidate.recommendation.grade).toBe('related')
  })
})
