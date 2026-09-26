import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { evaluatedRecommendation, unevaluatedRecommendation } from '../src/recommend/taxonomy'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryStore } from '../src/store/memory'
import { CANDIDATE_LIST_PAGE_SIZE, asCandidateId, err, ok, parseHttpUrl, type EvaluateSystemOne, type FetchPage } from '../src/types'
import { accessIdentity, bearerAuthorization, TEST_ACCESS_EMAIL, TEST_BINDINGS, TEST_CLIP_TOKEN } from './bindings'
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

function appWith(
  fetchPage: FetchPage = fetchHtml({}),
  evaluateRecommend?: EvaluateSystemOne,
  accessEmail: string | null = null,
) {
  const candidateStore = createMemoryCandidateStore()
  const queue = createFakeQueue()
  const app = createApp({
    store: createMemoryStore(),
    queue,
    candidateStore,
    fetchPage,
    ...(evaluateRecommend === undefined ? {} : { evaluateRecommend }),
    ...(accessEmail === null ? {} : accessIdentity(accessEmail)),
  })
  const env = {
    ...TEST_BINDINGS,
    CLIP_QUEUE: queue,
    ...(evaluateRecommend === undefined ? {} : { OPENROUTER_API_KEY: 'or-test' }),
  } as Cloudflare.Env
  return { app, candidateStore, env }
}

function appWithAccess(fetchPage: FetchPage = fetchHtml({}), evaluateRecommend?: EvaluateSystemOne) {
  return appWith(fetchPage, evaluateRecommend, TEST_ACCESS_EMAIL)
}

function csrfFrom(body: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(body)
  if (match?.[1] === undefined) {
    throw new Error('missing csrf')
  }
  return match[1]
}

describe('candidate HTTP auth', () => {
  it('rejects unauthenticated JSON writes and HTML list', async () => {
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
    expect(htmlGet.status).toBe(401)
    const htmlBody = await htmlGet.text()
    expect(htmlBody).toContain('Google アカウントで入る')
    expect(htmlBody).not.toContain(TEST_CLIP_TOKEN)
    expect(htmlBody).not.toContain('name="token"')
  })

  it('redirects the old token login path and does not embed CLIP_TOKEN', async () => {
    const { app, env } = appWithAccess(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
    )
    const login = await app.request('/candidates/login', {}, env)
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/candidates')

    const list = await app.request('/candidates', {}, env)
    const listHtml = await list.text()
    expect(list.status).toBe(200)
    expect(listHtml).not.toContain(TEST_CLIP_TOKEN)
    expect(listHtml).toContain('Asia/Tokyo')
  })

  it('rejects Access form POSTs without a matching CSRF token', async () => {
    const { app, env } = appWithAccess(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
    )
    const denied = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
    const listedCount = CANDIDATE_LIST_PAGE_SIZE + 1
    for (let i = 0; i < listedCount; i += 1) {
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
    const first = (await page1.json()) as {
      total: number
      pageSize: number
      filters: { title: string; grade: string; outlet: string }
      outlets: string[]
      groups: { items: unknown[] }[]
    }
    const second = (await page2.json()) as { page: number; groups: { items: unknown[] }[] }
    expect(first.pageSize).toBe(CANDIDATE_LIST_PAGE_SIZE)
    expect(first.total).toBe(listedCount)
    expect(first.filters).toEqual({ title: '', grade: '', outlet: '' })
    expect(first.outlets).toEqual(['Example'])
    expect(first.groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(CANDIDATE_LIST_PAGE_SIZE)
    expect(second.page).toBe(2)
    expect(second.groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(1)
  })

  it('shows the newer publication date above an older one', async () => {
    const { app, candidateStore, env } = appWithAccess()
    const put = async (id: string, title: string, publishedAt: string) => {
      const url = parseHttpUrl(`https://example.com/${id}`)
      if (url === null) {
        throw new Error('url')
      }
      await candidateStore.put({
        id: asCandidateId(id),
        canonicalUrl: url,
        sourceUrl: url,
        title,
        outlet: 'Example',
        publishedAt,
        discoveredAt: '2026-09-01T00:00:00.000Z',
        fetchStatus: 'fetched',
        listingState: 'listed',
        exclusionReason: null,
        fullTextState: 'unconfirmed',
        completedArticleId: null,
        clipJobId: null,
        clipRunId: null,
        selectedAt: null,
        recommendation: unevaluatedRecommendation(),
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      })
    }
    await put('cand_00000000000000000000000000000001', '古い記事', '2026-09-01T00:00:00.000Z')
    await put('cand_ffffffffffffffffffffffffffffffff', '新しい記事', '2026-09-26T15:00:00.000Z')
    const listed = await app.request('/candidates', {}, env)
    const body = await listed.text()
    const newer = body.indexOf('2026-09-27')
    const older = body.indexOf('2026-09-01')
    expect(newer).toBeGreaterThan(0)
    expect(older).toBeGreaterThan(newer)
    expect(body.indexOf('新しい記事')).toBeLessThan(body.indexOf('古い記事'))
    expect(body).not.toContain('min-width: 56rem')
  })

  it('filters the JSON list by title, grade, and outlet', async () => {
    const { app, candidateStore, env } = appWith()
    const now = '2026-09-21T00:00:00.000Z'
    const put = async (
      index: number,
      title: string,
      outlet: string,
      recommendation: ReturnType<typeof unevaluatedRecommendation> | ReturnType<typeof evaluatedRecommendation>,
    ) => {
      const url = parseHttpUrl(`https://example.com/p/${index}`)
      if (url === null) {
        throw new Error('url')
      }
      await candidateStore.put({
        id: asCandidateId(`cand_${index.toString().padStart(32, '0')}`),
        canonicalUrl: url,
        sourceUrl: url,
        title,
        outlet,
        publishedAt: now,
        discoveredAt: now,
        fetchStatus: 'fetched',
        listingState: 'listed',
        exclusionReason: null,
        fullTextState: 'unconfirmed',
        completedArticleId: null,
        clipJobId: null,
        clipRunId: null,
        selectedAt: null,
        recommendation,
        createdAt: now,
        updatedAt: now,
      })
    }
    await put(1, 'Cloudflare Workers', 'Example', unevaluatedRecommendation())
    await put(
      2,
      'データ基盤の設計',
      'Zenn',
      evaluatedRecommendation({
        grade: 'recommended',
        confidence: 0.91,
        model: 'jev-test',
        excerptHash: 'h',
        evaluatedAt: now,
        relevant: true,
        concrete: true,
        verification: false,
        inputTokens: 8,
        durationMs: 4,
      }),
    )
    const headers = { authorization: bearerAuthorization() }
    const byTitle = await app.request('/candidates.json?title=Workers', { headers }, env)
    const titleBody = (await byTitle.json()) as {
      total: number
      filters: { title: string }
      groups: { items: { title: string }[] }[]
    }
    expect(titleBody.total).toBe(1)
    expect(titleBody.filters.title).toBe('Workers')
    expect(titleBody.groups.flatMap((group) => group.items.map((item) => item.title))).toEqual(['Cloudflare Workers'])

    const byGrade = await app.request('/candidates.json?grade=recommended', { headers }, env)
    const gradeBody = (await byGrade.json()) as { total: number; groups: { items: { outlet: string }[] }[] }
    expect(gradeBody.total).toBe(1)
    expect(gradeBody.groups.flatMap((group) => group.items.map((item) => item.outlet))).toEqual(['Zenn'])

    const byOutlet = await app.request('/candidates.json?outlet=Example', { headers }, env)
    const outletBody = (await byOutlet.json()) as { total: number }
    expect(outletBody.total).toBe(1)

    const none = await app.request('/candidates.json?title=Workers&outlet=Zenn', { headers }, env)
    expect(((await none.json()) as { total: number }).total).toBe(0)
  })
})

describe('candidate HTML form', () => {
  it('accepts Access identity with CSRF and shows fetch failure state', async () => {
    const { app, env } = appWithAccess(async (url) => err({ kind: 'fetch_failed', url, reason: 'HTTP 502' }))
    const formPage = await app.request('/candidates', {}, env)
    const csrf = csrfFrom(await formPage.text())
    const submitted = await app.request(
      '/candidates',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url: 'https://down.example.com/a', csrf }).toString(),
      },
      env,
    )
    expect(submitted.status).toBe(303)
    expect(submitted.headers.get('location')).toContain('notice=fetch_failed')
    const listed = await app.request(submitted.headers.get('location') ?? '/candidates', {}, env)
    const listedHtml = await listed.text()
    expect(listedHtml).toContain('公開日の新しい順')
    expect(listedHtml).toContain('ソース')
    expect(listedHtml).toContain('絞り込む')
    expect(listedHtml).toContain('取得失敗')
    expect(listedHtml).not.toContain('本文取得済み')
    expect(listedHtml).not.toContain(TEST_CLIP_TOKEN)
  })

  it('rejects clip POSTs without CSRF and accepts an Access send', async () => {
    const { app, env } = appWithAccess(
      fetchHtml({ 'https://example.com/ja/workers-cpu': html('ja-tech.html') }),
    )
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
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: 'nope' }).toString(),
      },
      env,
    )
    expect(denied.status).toBe(403)

    const formPage = await app.request('/candidates?title=CPU', {}, env)
    const formHtml = await formPage.text()
    expect(formHtml).toContain('公開日の新しい順')
    expect(formHtml).toContain('name="return_to" value="title=CPU"')
    const csrf = csrfFrom(formHtml)
    const sent = await app.request(
      `/candidates/${id}/clip`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, return_to: 'title=CPU' }).toString(),
      },
      env,
    )
    expect(sent.status).toBe(303)
    expect(sent.headers.get('location')).toBe('/candidates?title=CPU&notice=clipped')
  })

  it('keeps HTML filters selected and in paging links', async () => {
    const { app, candidateStore, env } = appWithAccess()
    const now = '2026-09-21T00:00:00.000Z'
    const put = async (index: number, outlet: string, recommendation: ReturnType<typeof unevaluatedRecommendation> | ReturnType<typeof evaluatedRecommendation>) => {
      const url = parseHttpUrl(`https://example.com/p/${index}`)
      if (url === null) {
        throw new Error('url')
      }
      await candidateStore.put({
        id: asCandidateId(`cand_${index.toString().padStart(32, '0')}`),
        canonicalUrl: url,
        sourceUrl: url,
        title: `Article ${index}`,
        outlet,
        publishedAt: now,
        discoveredAt: now,
        fetchStatus: 'fetched',
        listingState: 'listed',
        exclusionReason: null,
        fullTextState: 'unconfirmed',
        completedArticleId: null,
        clipJobId: null,
        clipRunId: null,
        selectedAt: null,
        recommendation,
        createdAt: now,
        updatedAt: now,
      })
    }
    for (let i = 0; i < CANDIDATE_LIST_PAGE_SIZE + 1; i += 1) {
      await put(i, 'Example', unevaluatedRecommendation())
    }
    await put(
      99,
      'Zenn',
      evaluatedRecommendation({
        grade: 'recommended',
        confidence: 0.9,
        model: 'jev-test',
        excerptHash: 'h',
        evaluatedAt: now,
        relevant: true,
        concrete: false,
        verification: false,
        inputTokens: 8,
        durationMs: 3,
      }),
    )
    const pending = await app.request(
      '/candidates?title=Article&grade=pending&outlet=Example',
      {},
      env,
    )
    const pendingHtml = await pending.text()
    expect(pendingHtml).toContain('value="pending" selected')
    expect(pendingHtml).toContain('value="Example" selected')
    expect(pendingHtml).toContain('value="Article"')
    expect(pendingHtml).toContain('href="/candidates?title=Article&amp;grade=pending&amp;outlet=Example&amp;page=2"')
    expect(pendingHtml).not.toContain('Article 99')

    const recommended = await app.request('/candidates?grade=recommended', {}, env)
    const recommendedHtml = await recommended.text()
    expect(recommendedHtml).toContain('value="recommended" selected')
    expect(recommendedHtml).toContain('Article 99')
    expect(recommendedHtml).not.toContain('Article 1')
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
    const { app, env } = appWithAccess(
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

    const listHtml = await app.request('/candidates', {}, env)
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

    const { app: accessApp, env: accessEnv } = appWithAccess()
    const denied = await accessApp.request(
      `/candidates/${id}/recommend`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: 'nope' }).toString(),
      },
      accessEnv,
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
