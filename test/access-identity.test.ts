import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { ACCESS_LOGOUT_PATH } from '../src/http/clip-web-auth'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import { createMemoryStore } from '../src/store/memory'
import { TEST_ACCESS_EMAIL, TEST_BINDINGS, TEST_CLIP_TOKEN, accessIdentity } from './bindings'
import { createFakeQueue } from './fake-queue'

function executionContext(email?: string): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
    abort() {},
    ...(email === undefined
      ? {}
      : {
          access: {
            aud: 'test-aud',
            getIdentity: async () => ({ email }),
          },
        }),
  } as unknown as ExecutionContext
}

function testApp(overrides: Parameters<typeof createApp>[0] = {}) {
  const queue = createFakeQueue()
  const app = createApp({
    store: createMemoryStore(),
    queue,
    candidateStore: createMemoryCandidateStore(),
    ...overrides,
  })
  const env = { ...TEST_BINDINGS, CLIP_QUEUE: queue } as Cloudflare.Env
  return { app, env }
}

describe('Access identity', () => {
  it('accepts ctx.access email and logs out through Cloudflare Access', async () => {
    const { app, env } = testApp()
    const listed = await app.fetch(new Request('http://example.com/candidates'), env, executionContext(TEST_ACCESS_EMAIL))
    expect(listed.status).toBe(200)
    const html = await listed.text()
    expect(html).toContain('読書候補')
    expect(html).not.toContain(TEST_CLIP_TOKEN)

    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
    expect(csrf).toBeTruthy()
    const logout = await app.fetch(
      new Request('http://example.com/candidates/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: csrf ?? '' }).toString(),
      }),
      env,
      executionContext(TEST_ACCESS_EMAIL),
    )
    expect(logout.status).toBe(303)
    expect(logout.headers.get('location')).toBe(ACCESS_LOGOUT_PATH)
  })

  it('rejects HTML when Access did not run', async () => {
    const { app, env } = testApp()
    const listed = await app.fetch(new Request('http://example.com/candidates'), env, executionContext())
    expect(listed.status).toBe(401)
    expect(await listed.text()).toContain('Google アカウントで入る')
  })

  it('rejects HTML when Access identity is missing', async () => {
    const { app, env } = testApp({ getAccessIdentity: async () => null })
    const listed = await app.request('/candidates', {}, env)
    expect(listed.status).toBe(401)
  })

  it('still accepts Bearer JSON without Access', async () => {
    const { app, env } = testApp(accessIdentity())
    const listed = await app.request(
      '/candidates.json',
      { headers: { authorization: `Bearer ${TEST_CLIP_TOKEN}` } },
      env,
    )
    expect(listed.status).toBe(200)
  })
})
