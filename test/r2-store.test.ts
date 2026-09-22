import { describe, expect, it, vi } from 'vitest'
import { classifiedClassification, lowConfidenceClassification } from '../src/classify/taxonomy'
import { createR2Store } from '../src/store/r2'
import { articleEpubKey, articleMetaKey, asArticleId, asClipJobId, asClipRunId, asEpubBytes, clipJobKey, parseHttpUrl } from '../src/types'
import { createFakeR2Bucket } from './fake-r2'

function url(value: string) {
  const parsed = parseHttpUrl(value)
  if (parsed === null) {
    throw new Error(value)
  }
  return parsed
}

function jaArticle(id: string, title: string, slug: string, bytes: number[] = [1]) {
  return {
    id: asArticleId(id),
    title,
    author: null,
    publishedAt: null,
    sourceUrl: url(`https://example.com/${slug}`),
    canonicalUrl: url(`https://example.com/${slug}`),
    language: 'ja' as const,
    translated: false,
    epub: asEpubBytes(new Uint8Array(bytes)),
  }
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
      runId: asClipRunId('run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      sourceUrl: url('https://example.com/queued'),
      status: 'queued',
      articleId: null,
      error: null,
      attempt: 0,
      stages: [],
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

  it('writes book.epub before meta.json so new articles are unpublished if EPUB fails', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const article = jaArticle('art_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '未完成', 'new-fail')
    bucket.failNextPut(articleEpubKey(article.id))
    await expect(store.put(article)).rejects.toThrow('R2 put failed')
    expect(await bucket.head(articleEpubKey(article.id))).toBeNull()
    expect(await bucket.head(articleMetaKey(article.id))).toBeNull()
    expect(await store.listMeta()).toEqual([])
  })

  it('does not publish a new article when metadata write fails after EPUB', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const article = jaArticle('art_14141414141414141414141414141414', 'meta失敗', 'meta-fail')
    bucket.failNextPut(articleMetaKey(article.id))
    await expect(store.put(article)).rejects.toThrow('R2 put failed')
    expect(await bucket.head(articleEpubKey(article.id))).not.toBeNull()
    expect(await store.getMeta(article.id)).toBeNull()
    expect(await store.listMeta()).toEqual([])
  })

  it('does not list meta.json without a matching EPUB', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const id = asArticleId('art_ffffffffffffffffffffffffffffffff')
    await bucket.put(
      articleMetaKey(id),
      JSON.stringify({
        id,
        title: 'EPUBなし',
        author: null,
        publishedAt: null,
        sourceUrl: 'https://example.com/meta-only',
        canonicalUrl: 'https://example.com/meta-only',
        language: 'ja',
        translated: false,
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
      }),
    )
    expect(await store.listMeta()).toEqual([])
    expect(await store.getMeta(id)).not.toBeNull()
  })

  it('reads pre-classification meta.json as skipped uncategorized', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const id = asArticleId('art_15151515151515151515151515151515')
    await bucket.put(
      articleMetaKey(id),
      JSON.stringify({
        id,
        title: '旧メタ',
        author: null,
        publishedAt: null,
        sourceUrl: 'https://example.com/legacy',
        canonicalUrl: 'https://example.com/legacy',
        language: 'ja',
        translated: false,
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
      }),
    )
    await bucket.put(articleEpubKey(id), new Uint8Array([1]))
    const meta = await store.getMeta(id)
    expect(meta?.title).toBe('旧メタ')
    expect(meta?.classification).toMatchObject({
      status: 'skipped',
      topic: 'uncategorized',
      kind: 'uncategorized',
    })
    expect((await store.listMeta())[0]?.classification.status).toBe('skipped')
  })

  it('round-trips classified meta.json and updates classification without rewriting EPUB', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const article = jaArticle('art_16161616161616161616161616161616', '分類', 'classified')
    const first = await store.put({
      ...article,
      classification: classifiedClassification({
        model: 'jev-1.13.0',
        durationMs: 90,
        inputTokens: 410,
        topic: 'tech',
        kind: 'explainer',
        topicConfidence: 0.94,
        kindConfidence: 0.91,
      }),
    })
    expect(await store.getMeta(article.id)).toEqual(first)
    expect((await store.listMeta())[0]?.classification).toMatchObject({
      status: 'classified',
      topic: 'tech',
      kind: 'explainer',
    })
    const writesBeforeUpdate = bucket.putOrder().length
    const updated = await store.putClassification(
      article.id,
      lowConfidenceClassification({
        model: 'jev-1.13.0',
        durationMs: 90,
        inputTokens: 410,
        topic: 'uncategorized',
        kind: 'explainer',
        decidedTopic: 'tech',
        decidedKind: 'explainer',
        topicConfidence: 0.4,
        kindConfidence: 0.91,
      }),
    )
    expect(updated?.classification.status).toBe('low_confidence')
    expect(await store.getEpub(article.id)).toEqual(article.epub)
    expect(bucket.putOrder().slice(writesBeforeUpdate)).toEqual([articleMetaKey(article.id)])
    expect(await store.putClassification(asArticleId('art_17171717171717171717171717171717'), first.classification)).toBeNull()
  })

  it('keeps the previous article when an update EPUB write fails', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const firstWrite = jaArticle('art_12121212121212121212121212121212', '初回', 'update-fail')
    const first = await store.put(firstWrite)
    bucket.failNextPut(articleEpubKey(firstWrite.id))
    await expect(store.put({ ...firstWrite, title: '失敗する更新', epub: asEpubBytes(new Uint8Array([2])) })).rejects.toThrow(
      'R2 put failed',
    )
    expect(await store.getMeta(firstWrite.id)).toEqual(first)
    expect(await store.getEpub(firstWrite.id)).toEqual(new Uint8Array([1]))
    expect(await store.listMeta()).toEqual([first])
  })

  it('writes EPUB before metadata', async () => {
    const bucket = createFakeR2Bucket()
    const store = createR2Store({ ARTICLES: bucket })
    const article = jaArticle('art_13131313131313131313131313131313', '順', 'order')
    await store.put(article)
    expect(bucket.putOrder()).toEqual([articleEpubKey(article.id), articleMetaKey(article.id)])
  })

  it('includes jobId on store logs when a log context is passed', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      const bucket = createFakeR2Bucket()
      const store = createR2Store({ ARTICLES: bucket })
      const article = jaArticle('art_15151515151515151515151515151515', 'ログ', 'store-log')
      await store.put(article, {
        jobId: asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        runId: asClipRunId('run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        attempt: 1,
      })
      const storeLog = logs
        .map((line) => JSON.parse(line) as { event?: string; stage?: string; jobId?: string })
        .find((entry) => entry.event === 'pipeline' && entry.stage === 'store')
      expect(storeLog).toMatchObject({
        event: 'pipeline',
        stage: 'store',
        jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        articleId: article.id,
      })
      expect(JSON.stringify(storeLog)).not.toContain('本文')
    } finally {
      spy.mockRestore()
    }
  })
})
