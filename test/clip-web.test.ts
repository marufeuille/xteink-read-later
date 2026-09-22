import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { clipWebBookmarklet } from '../src/clip/bookmarklet'
import { clipWebUrlContainsSecret, clipWebUrlPreview } from '../src/clip/html'
import { accessCsrfToken } from '../src/http/candidate-session'
import { createMemoryStore } from '../src/store/memory'
import { clipJobIdFromUrl, parseHttpUrl } from '../src/types'
import {
  accessIdentity,
  bearerAuthorization,
  TEST_BINDINGS,
  TEST_CLIP_TOKEN,
} from './bindings'
import { createFakeQueue } from './fake-queue'

const ARTICLE_URL = 'https://example.com/articles/pc-clip'

function appWith(options: { onSend?: () => void; access?: boolean } = {}) {
  const store = createMemoryStore()
  const queue = createFakeQueue({
    ...(options.onSend === undefined ? {} : { onSend: options.onSend }),
  })
  const app = createApp({
    store,
    queue,
    ...(options.access === false ? {} : accessIdentity()),
  })
  const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
  return { app, store, queue, env }
}

function csrfFrom(html: string): string {
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
  if (csrf === undefined) {
    throw new Error('csrf missing')
  }
  return csrf
}

describe('clip web bookmarklet', () => {
  it('opens /clip/web with the current tab and does not embed a token', () => {
    const bookmarklet = clipWebBookmarklet('https://xteink-read-later.example.workers.dev/')
    expect(bookmarklet).toBe(
      `javascript:(function(){location.href="https://xteink-read-later.example.workers.dev/clip/web?url="+encodeURIComponent(location.href)})()`,
    )
    expect(bookmarklet).not.toContain('CLIP_TOKEN')
    expect(bookmarklet).not.toContain('Bearer')
    expect(bookmarklet).not.toContain(TEST_CLIP_TOKEN)
    expect(() => clipWebBookmarklet('javascript:alert(1)')).toThrow(/http/)
    expect(() => clipWebBookmarklet('https://user:secret@example.com')).toThrow(/credentials/)
  })

  it('hides previews that contain the clip token', () => {
    expect(clipWebUrlPreview(`https://example.com/?k=${TEST_CLIP_TOKEN}`, TEST_CLIP_TOKEN)).toBe('')
    expect(clipWebUrlContainsSecret(ARTICLE_URL, TEST_CLIP_TOKEN)).toBe(false)
    expect(clipWebUrlPreview('javascript:alert(1)', TEST_CLIP_TOKEN)).toBe('javascript:alert(1)')
  })
})

describe('GET /clip/web', () => {
  it('shows the URL and does not enqueue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      const { app, queue, store, env } = appWith()
      const response = await app.request(`/clip/web?url=${encodeURIComponent(ARTICLE_URL)}`, {}, env)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('クリップする')
      expect(html).toContain(ARTICLE_URL)
      expect(html).toContain('このページを開いただけでは受け付けません')
      expect(html).not.toContain(TEST_CLIP_TOKEN)
      expect(html).not.toContain('Bearer')
      expect(queue.size).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
      const parsedUrl = parseHttpUrl(ARTICLE_URL)
      if (parsedUrl === null) {
        throw new Error('url')
      }
      const jobId = await clipJobIdFromUrl(parsedUrl)
      expect(await store.getJob(jobId)).toBeNull()
      expect(logs.join('\n')).not.toContain(ARTICLE_URL)
      expect(logs.join('\n')).not.toContain(TEST_CLIP_TOKEN)
    } finally {
      fetchSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('shows a bookmarklet without a token when the URL is missing', async () => {
    const { app, queue, env } = appWith()
    const response = await app.request('https://read.example/clip/web/', {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('https://read.example/clip/web?url=')
    expect(html).toContain('encodeURIComponent(location.href)')
    expect(html).not.toContain('クリップする')
    expect(html).not.toContain(TEST_CLIP_TOKEN)
    expect(queue.size).toBe(0)
  })

  it('rejects an invalid URL without enqueueing', async () => {
    const { app, queue, env } = appWith()
    const response = await app.request('/clip/web?url=javascript:alert(1)', {}, env)
    expect(response.status).toBe(400)
    const html = await response.text()
    expect(html).toContain('受け付けていません')
    expect(html).not.toContain(TEST_CLIP_TOKEN)
    expect(queue.size).toBe(0)
  })

  it('does not display a URL that contains the clip token', async () => {
    const { app, queue, env } = appWith()
    const response = await app.request(
      `/clip/web?url=${encodeURIComponent(`https://example.com/?k=${TEST_CLIP_TOKEN}`)}`,
      {},
      env,
    )
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(TEST_CLIP_TOKEN)
    expect(queue.size).toBe(0)
  })

  it('asks for Google when Access did not run', async () => {
    const { app, env } = appWith({ access: false })
    const response = await app.request(`/clip/web?url=${encodeURIComponent(ARTICLE_URL)}`, {}, env)
    expect(response.status).toBe(401)
    const html = await response.text()
    expect(html).toContain('Google アカウントで入る')
    expect(html).not.toContain(TEST_CLIP_TOKEN)
  })
})

describe('POST /clip/web', () => {
  it('enqueues with the same 202 contract as POST /clip and does not double-enqueue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const { app, queue, env } = appWith()
      const page = await app.request(`/clip/web?url=${encodeURIComponent(ARTICLE_URL)}`, {}, env)
      const csrf = csrfFrom(await page.text())
      expect(csrf).toBe(await accessCsrfToken('admin@example.com', TEST_CLIP_TOKEN))

      const form = new URLSearchParams({ csrf, url: ARTICLE_URL })
      const accepted = await app.request(
        '/clip/web',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        },
        env,
      )
      expect(accepted.status).toBe(202)
      expect(accepted.headers.get('location')).toMatch(/^\/clip\/jobs\/job_[a-f0-9]{32}$/)
      const html = await accepted.text()
      const jobId = /jobId: (job_[a-f0-9]{32})/.exec(html)?.[1]
      expect(jobId).toBeTruthy()
      expect(html).toContain('status: queued')
      expect(html).not.toContain(TEST_CLIP_TOKEN)
      expect(queue.size).toBe(1)
      expect(queue.peek()[0]?.url).toBe(ARTICLE_URL)
      expect(fetchSpy).not.toHaveBeenCalled()

      const again = await app.request(
        '/clip/web/',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        },
        env,
      )
      expect(again.status).toBe(202)
      expect(await again.text()).toContain('二重には載せません')
      expect(queue.size).toBe(1)

      const viaApi = await app.request(
        '/clip',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: bearerAuthorization(),
          },
          body: JSON.stringify({ url: ARTICLE_URL }),
        },
        env,
      )
      expect(viaApi.status).toBe(202)
      const apiBody = (await viaApi.json()) as { jobId: string; status: string; sourceUrl: string }
      expect(apiBody).toEqual({ jobId, status: 'queued', sourceUrl: ARTICLE_URL })
      expect(queue.size).toBe(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('returns the POST /clip JSON body for a JSON submit', async () => {
    const { app, env } = appWith()
    const page = await app.request(`/clip/web?url=${encodeURIComponent(ARTICLE_URL)}`, {}, env)
    const csrf = csrfFrom(await page.text())
    const response = await app.request(
      '/clip/web',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ url: ARTICLE_URL }),
      },
      env,
    )
    expect(response.status).toBe(202)
    const body = (await response.json()) as { jobId: string; status: string; sourceUrl: string; title?: string }
    expect(body.status).toBe('queued')
    expect(body.sourceUrl).toBe(ARTICLE_URL)
    expect(body.jobId).toMatch(/^job_[a-f0-9]{32}$/)
    expect(body.title).toBeUndefined()
  })

  it('rejects a missing CSRF token without enqueueing', async () => {
    const { app, queue, env } = appWith()
    const response = await app.request(
      '/clip/web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url: ARTICLE_URL }).toString(),
      },
      env,
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('csrf_failed')
    expect(queue.size).toBe(0)
  })

  it('rejects an invalid URL without enqueueing', async () => {
    const { app, queue, env } = appWith()
    const csrf = await accessCsrfToken('admin@example.com', TEST_CLIP_TOKEN)
    const response = await app.request(
      '/clip/web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, url: 'not a url' }).toString(),
      },
      env,
    )
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(TEST_CLIP_TOKEN)
    expect(queue.size).toBe(0)
  })

  it('returns 503 when the queue send fails and does not log the URL', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      const { app, env } = appWith({
        onSend: () => {
          throw new Error('queue down')
        },
      })
      const page = await app.request(`/clip/web?url=${encodeURIComponent(ARTICLE_URL)}`, {}, env)
      const csrf = csrfFrom(await page.text())
      const response = await app.request(
        '/clip/web',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, url: ARTICLE_URL }).toString(),
        },
        env,
      )
      expect(response.status).toBe(503)
      const html = await response.text()
      expect(html).toContain('Queue への送信に失敗しました')
      expect(html).not.toContain(ARTICLE_URL)
      expect(html).not.toContain(TEST_CLIP_TOKEN)
      expect(logs.join('\n')).not.toContain(ARTICLE_URL)
      expect(logs.join('\n')).not.toContain(TEST_CLIP_TOKEN)
    } finally {
      logSpy.mockRestore()
    }
  })
})
