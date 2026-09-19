import { describe, expect, it } from 'vitest'
import { createR2Store } from '../src/store/r2'
import { articleEpubKey, articleMetaKey, asArticleId, asClipJobId, asEpubBytes, clipJobKey, parseHttpUrl } from '../src/types'
import { createFakeR2Bucket } from './fake-r2'

function url(value: string) {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

describe('createR2Store', () => {
  it('writes meta.json and book.epub, then serves and deletes them', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const id = asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const epub = asEpubBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    const meta = await store.put({
      id,
      title: '保存テスト',
      author: '石井',
      publishedAt: '2026-09-19T00:00:00.000Z',
      sourceUrl: url('https://example.com/ja/r2'),
      canonicalUrl: url('https://example.com/ja/r2'),
      language: 'ja',
      translated: false,
      epub,
    })
    expect(await bucket.head(articleMetaKey(id))).not.toBeNull()
    expect(await bucket.head(articleEpubKey(id))).not.toBeNull()
    expect(await store.getMeta(id)).toEqual(meta)
    expect(await store.getEpub(id)).toEqual(epub)

    const listed = await store.listMeta()
    expect(listed.map((item) => item.id)).toEqual([id])

    expect(await store.delete(id)).toBe(true)
    expect(await store.getMeta(id)).toBeNull()
    expect(await store.getEpub(id)).toBeNull()
    expect(await store.delete(id)).toBe(false)
  })

  it('stores job records under jobs/ and does not list them in OPDS meta', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const jobId = asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    await store.putJob({
      jobId,
      sourceUrl: url('https://example.com/queued'),
      status: 'queued',
      articleId: null,
      error: null,
      attempt: 0,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    })
    expect(await bucket.head(clipJobKey(jobId))).not.toBeNull()
    expect(await store.getJob(jobId)).toMatchObject({ status: 'queued', jobId })
    expect(await store.listMeta()).toEqual([])
  })

  it('overwrites the same canonical article and keeps createdAt', async () => {
    const store = createR2Store({ ARTICLES: createFakeR2Bucket() })
    const id = asArticleId('art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const first = await store.put({
      id,
      title: '初回',
      author: null,
      publishedAt: null,
      sourceUrl: url('https://example.com/same'),
      canonicalUrl: url('https://example.com/same'),
      language: 'ja',
      translated: false,
      epub: asEpubBytes(new Uint8Array([1])),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await store.put({
      id,
      title: '上書き',
      author: null,
      publishedAt: null,
      sourceUrl: url('https://example.com/same'),
      canonicalUrl: url('https://example.com/same'),
      language: 'ja',
      translated: true,
      epub: asEpubBytes(new Uint8Array([2])),
    })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt >= first.updatedAt).toBe(true)
    expect(second.title).toBe('上書き')
    expect(second.translated).toBe(true)
    expect(await store.getEpub(id)).toEqual(new Uint8Array([2]))
  })

  it('lists metadata newest-first and skips unreadable meta.json', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const older = asArticleId('art_cccccccccccccccccccccccccccccccc')
    const newer = asArticleId('art_dddddddddddddddddddddddddddddddd')
    await store.put({
      id: older,
      title: '古い',
      author: null,
      publishedAt: null,
      sourceUrl: url('https://example.com/old'),
      canonicalUrl: url('https://example.com/old'),
      language: 'ja',
      translated: false,
      epub: asEpubBytes(new Uint8Array([1])),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.put({
      id: newer,
      title: '新しい',
      author: null,
      publishedAt: null,
      sourceUrl: url('https://example.com/new'),
      canonicalUrl: url('https://example.com/new'),
      language: 'ja',
      translated: false,
      epub: asEpubBytes(new Uint8Array([2])),
    })
    await bucket.put('articles/not-an-id/meta.json', '{not json')
    const listed = await store.listMeta()
    expect(listed.map((item) => item.id)).toEqual([newer, older])
  })
})
