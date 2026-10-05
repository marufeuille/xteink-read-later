import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { createClipPipeline } from '../../src/pipeline/clip'
import { DEFAULT_SMOKE_ARTICLE_URL, SMOKE_PHRASE } from '../../src/smoke/constants'
import { notifyIfSmokeFailed, requestTarget, runDeploySmoke, cleanupSmokeArticle } from '../../src/smoke/run'
import { createMemoryStore } from '../../src/store/memory'
import { articleIdFromCanonicalUrl, parseHttpUrl } from '../../src/types'
import { TEST_BINDINGS } from '../bindings'
import { createFakeQueue } from '../fake-queue'
import { installNetworkMock } from './mock-network'

const fixtures = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(fixtures, '..', '..', 'pages/smoke/article.html'), 'utf8')
const ORIGIN = 'https://read.example.com'
const TOKEN = 'smoke-clip-token-value'
const USER = 'smoke-opds-user'
const PASS = 'smoke-opds-password-value'
const WEBHOOK = 'https://hooks.slack.example/services/T000/B000/secret-hook'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const RUN = 'https://github.com/marufeuille/xteink-read-later/actions/runs/99'

afterEach(() => {
  vi.unstubAllGlobals()
})

function settings() {
  return {
    clipToken: TOKEN,
    opdsUsername: USER,
    opdsPassword: PASS,
    slackWebhookUrl: WEBHOOK,
    articleUrl: DEFAULT_SMOKE_ARTICLE_URL,
    origin: ORIGIN,
    githubSha: SHA,
    workerVersion: 'version-from-deploy',
    runUrl: RUN,
  }
}

describe('deploy smoke against a mock worker', () => {
  it('clips the Pages article through OPDS and EPUB, then deletes it', async () => {
    const network = installNetworkMock({
      pages: { [DEFAULT_SMOKE_ARTICLE_URL]: { html } },
    })
    const store = createMemoryStore()
    const queue = createFakeQueue()
    const clipPipeline = createClipPipeline()
    const app = createApp({ store, queue })
    const env = {
      ...TEST_BINDINGS,
      SMOKE_CLIP_TOKEN_SHA256: createHash('sha256').update(TOKEN, 'utf8').digest('hex'),
      SMOKE_OPDS_BASIC_SHA256: createHash('sha256').update(`${USER}:${PASS}`, 'utf8').digest('hex'),
      SMOKE_ARTICLE_URL: DEFAULT_SMOKE_ARTICLE_URL,
      CLIP_QUEUE: queue,
    } as Cloudflare.Env
    let posts = 0
    const result = await runDeploySmoke({
      settings: settings(),
      fetch: async (input, init) => {
        const url = requestTarget(input)
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        if (url === DEFAULT_SMOKE_ARTICLE_URL) {
          return new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }
        const target = new URL(url)
        if (target.origin !== ORIGIN) {
          throw new Error(`unexpected origin ${target.origin}`)
        }
        const response = await app.request(url, { ...init, method }, env)
        if (method === 'POST' && target.pathname === '/clip') {
          posts += 1
          await queue.drain(env, { clipPipeline, store })
        }
        return response
      },
    })
    expect(result.kind).toBe('passed')
    expect(posts).toBe(1)
    expect(network.fetchedUrls).toEqual([DEFAULT_SMOKE_ARTICLE_URL])
    if (result.kind !== 'passed') {
      return
    }
    const meta = await store.getMeta(result.state.articleId as never)
    expect(meta).not.toBeNull()
    const canonical = parseHttpUrl(DEFAULT_SMOKE_ARTICLE_URL)
    if (canonical === null || result.state.articleId === null) {
      throw new Error('id')
    }
    expect(result.state.articleId).toBe(await articleIdFromCanonicalUrl(canonical))
    const cleaned = await cleanupSmokeArticle({
      state: result.state,
      settings: settings(),
      fetch: async (input, init) => app.request(requestTarget(input), init, env),
    })
    expect(cleaned.ok).toBe(true)
    expect(await store.getMeta(result.state.articleId as never)).toBeNull()
  })

  it('calls notify when the mock worker rejects the smoke token', async () => {
    const app = createApp({ store: createMemoryStore(), queue: createFakeQueue() })
    const env = {
      ...TEST_BINDINGS,
      SMOKE_ARTICLE_URL: DEFAULT_SMOKE_ARTICLE_URL,
      CLIP_QUEUE: createFakeQueue(),
    } as Cloudflare.Env
    const calls: string[] = []
    const result = await runDeploySmoke({
      settings: settings(),
      fetch: async (input, init) => {
        const url = requestTarget(input)
        calls.push(url)
        if (url === DEFAULT_SMOKE_ARTICLE_URL) {
          return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        if (!url.startsWith(ORIGIN)) {
          throw new Error(`unexpected ${url}`)
        }
        return app.request(url, init, env)
      },
    })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.state.failedStep).toBe('post-clip')
      expect(result.state.errorKind).toBe('http_401')
    }
    const notify = vi.fn(async (message: string) => {
      expect(message.startsWith('[deploy-smoke]')).toBe(true)
      expect(message).not.toContain(TOKEN)
      expect(message).not.toContain(PASS)
      expect(message).not.toContain(WEBHOOK)
      expect(message).not.toContain(DEFAULT_SMOKE_ARTICLE_URL)
      expect(message).not.toContain(SMOKE_PHRASE)
    })
    expect(await notifyIfSmokeFailed(result, notify)).toBe(true)
    expect(notify).toHaveBeenCalledOnce()
    expect(calls.some((url) => url.includes('workers.dev'))).toBe(false)
    expect(calls.filter((url) => url.endsWith('/clip'))).toHaveLength(1)
  })
})
