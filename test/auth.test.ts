import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import {
  configuredSmokeHash,
  parseBasicCredentials,
  parseBearerToken,
  presentedMatchesSha256,
  secretsEqual,
  sha256HexDigest,
  smokeBasicMaterial,
} from '../src/http/auth'
import { createMemoryStore } from '../src/store/memory'
import { asArticleId, asEpubBytes, parseHttpUrl } from '../src/types'
import {
  basicAuthorization,
  bearerAuthorization,
  TEST_BINDINGS,
  TEST_CLIP_TOKEN,
  TEST_OPDS_PASSWORD,
  TEST_OPDS_USERNAME,
} from './bindings'

function dummyApp() {
  return createApp({
    store: createMemoryStore(),
  })
}

describe('auth helpers', () => {
  it('parses Bearer and Basic credentials', () => {
    expect(parseBearerToken(bearerAuthorization())).toBe(TEST_CLIP_TOKEN)
    expect(parseBearerToken('bearer clip-test-token')).toBe(TEST_CLIP_TOKEN)
    expect(parseBearerToken('Basic abc')).toBeNull()
    expect(parseBasicCredentials(basicAuthorization())).toEqual({
      username: TEST_OPDS_USERNAME,
      password: TEST_OPDS_PASSWORD,
    })
    expect(parseBasicCredentials('Basic ' + btoa('user:p:ass'))).toEqual({
      username: 'user',
      password: 'p:ass',
    })
  })

  it('rejects empty secrets even when both sides match', async () => {
    expect(await secretsEqual('', '')).toBe(false)
    expect(await secretsEqual(TEST_CLIP_TOKEN, TEST_CLIP_TOKEN)).toBe(true)
    expect(await secretsEqual(TEST_CLIP_TOKEN, 'other')).toBe(false)
  })

  it('compares smoke secrets by hashing the presented value', async () => {
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(await sha256HexDigest('abc')).toBe(abc)
    expect(configuredSmokeHash(`  ${abc.toUpperCase()}\n`)).toBe(abc)
    expect(await presentedMatchesSha256('abc', abc)).toBe(true)
    expect(await presentedMatchesSha256('abd', abc)).toBe(false)
    expect(await presentedMatchesSha256(abc, abc)).toBe(false)

    const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(await sha256HexDigest('')).toBe(emptyHash)
    expect(await presentedMatchesSha256('', emptyHash)).toBe(false)
    expect(configuredSmokeHash(undefined)).toBeNull()
    expect(configuredSmokeHash('')).toBeNull()
    expect(configuredSmokeHash('   ')).toBeNull()
    expect(configuredSmokeHash('not-a-hash')).toBeNull()
    expect(configuredSmokeHash(abc.slice(0, 63))).toBeNull()

    const material = smokeBasicMaterial('smoke-user', 'p:ass')
    expect(material).toBe('smoke-user:p:ass')
    const basicHash = await sha256HexDigest(material)
    expect(await presentedMatchesSha256(material, basicHash)).toBe(true)
    expect(await presentedMatchesSha256('smoke-user:other', basicHash)).toBe(false)
  })
})

describe('HTTP auth', () => {
  it('rejects clip and delete without a matching CLIP_TOKEN', async () => {
    const app = dummyApp()
    const missing = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/a' }),
      },
      TEST_BINDINGS,
    )
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')
    expect(await missing.text()).not.toContain(TEST_CLIP_TOKEN)

    const wrong = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization('wrong-token'),
        },
        body: JSON.stringify({ url: 'https://example.com/a' }),
      },
      TEST_BINDINGS,
    )
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).not.toContain('wrong-token')

    const deleted = await app.request(
      '/articles/art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      { method: 'DELETE' },
      TEST_BINDINGS,
    )
    expect(deleted.status).toBe(401)

    const job = await app.request('/clip/jobs/job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {}, TEST_BINDINGS)
    expect(job.status).toBe(401)
    expect(job.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('does not run the clip pipeline when CLIP_TOKEN is unset', async () => {
    const app = dummyApp()
    const response = await app.request(
      '/clip',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearerAuthorization(),
        },
        body: JSON.stringify({ url: 'https://example.com/a' }),
      },
      { OPENAI_API_KEY: 'sk-test' } as Cloudflare.Env,
    )
    expect(response.status).toBe(401)
  })

  it('requires HTTP Basic on OPDS and does not accept Bearer', async () => {
    const store = createMemoryStore()
    const id = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const sourceUrl = parseHttpUrl('https://example.com/a')
    if (sourceUrl === null) {
      throw new Error('url')
    }
    await store.put({
      id,
      title: '記事',
      author: null,
      publishedAt: null,
      sourceUrl,
      canonicalUrl: sourceUrl,
      language: 'ja',
      translated: false,
      epub: asEpubBytes(new Uint8Array([1, 2, 3])),
    })
    const app = createApp({
      store,
    })

    const noAuth = await app.request('https://read.example.com/opds', {}, TEST_BINDINGS)
    expect(noAuth.status).toBe(401)
    expect(noAuth.headers.get('www-authenticate')).toBe('Basic realm="Xteink Read Later"')

    const bearer = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: bearerAuthorization() } },
      TEST_BINDINGS,
    )
    expect(bearer.status).toBe(401)

    const wrong = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization('xteink', 'nope') } },
      TEST_BINDINGS,
    )
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).not.toContain(TEST_OPDS_PASSWORD)

    const okCatalog = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(okCatalog.status).toBe(200)

    const noAuthArticle = await app.request(`/articles/${id}`, {}, TEST_BINDINGS)
    expect(noAuthArticle.status).toBe(401)
    expect(noAuthArticle.headers.get('www-authenticate')).toBe('Basic realm="Xteink Read Later"')

    const bearerArticle = await app.request(
      `/articles/${id}`,
      { headers: { authorization: bearerAuthorization() } },
      TEST_BINDINGS,
    )
    expect(bearerArticle.status).toBe(401)

    const okArticle = await app.request(
      `/articles/${id}`,
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(okArticle.status).toBe(200)

    const noAuthEpub = await app.request(`/articles/${id}/book.epub`, {}, TEST_BINDINGS)
    expect(noAuthEpub.status).toBe(401)

    const okEpub = await app.request(
      `/articles/${id}/book.epub`,
      { headers: { authorization: basicAuthorization() } },
      TEST_BINDINGS,
    )
    expect(okEpub.status).toBe(200)

    const emptyPassword = await app.request(
      'https://read.example.com/opds',
      { headers: { authorization: basicAuthorization(TEST_OPDS_USERNAME, '') } },
      { ...TEST_BINDINGS, OPDS_PASSWORD: '' },
    )
    expect(emptyPassword.status).toBe(401)
  })
})
