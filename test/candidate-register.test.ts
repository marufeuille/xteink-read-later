import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertFetchableCandidateUrl } from '../src/candidates/fetch-policy'
import { calendarDateInTimeZone, groupCandidatesByPublishedDate } from '../src/candidates/list'
import { registerCandidate } from '../src/candidates/register'
import { createMemoryCandidateStore } from '../src/store/memory-candidates'
import {
  asCandidateId,
  err,
  ok,
  parseHttpUrl,
  type CandidateArticle,
  type FetchPage,
  type HttpUrl,
} from '../src/types'

const fixtures = dirname(fileURLToPath(import.meta.url))

function html(name: string): string {
  return readFileSync(join(fixtures, 'fixtures', name), 'utf8')
}

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function fetchHtml(pages: Record<string, { html: string; finalUrl?: string }>): FetchPage {
  return async (url) => {
    const page = pages[url]
    if (page === undefined) {
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    }
    return ok({
      requestedUrl: url,
      finalUrl: mustUrl(page.finalUrl ?? url),
      contentType: 'text/html',
      html: page.html,
    })
  }
}

describe('candidate fetch policy', () => {
  it('keeps public http(s) URLs and rejects loopback or private hosts', () => {
    expect(assertFetchableCandidateUrl(mustUrl('https://example.com/a')).ok).toBe(true)
    expect(assertFetchableCandidateUrl(mustUrl('http://127.0.0.1/')).ok).toBe(false)
    expect(assertFetchableCandidateUrl(mustUrl('http://localhost/secret')).ok).toBe(false)
    expect(assertFetchableCandidateUrl(mustUrl('http://192.168.1.8/')).ok).toBe(false)
    expect(assertFetchableCandidateUrl(mustUrl('http://10.0.0.2/')).ok).toBe(false)
    expect(assertFetchableCandidateUrl(mustUrl('http://169.254.169.254/latest')).ok).toBe(false)
  })
})

describe('registerCandidate', () => {
  it('stores metadata without translating and confirms free full text when extractable', async () => {
    const store = createMemoryCandidateStore()
    const result = await registerCandidate(mustUrl('https://example.com/ja/workers-cpu'), {
      store,
      fetchPage: fetchHtml({
        'https://example.com/ja/workers-cpu': { html: html('ja-tech.html') },
      }),
      now: () => new Date('2026-09-21T03:00:00.000Z'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.duplicate).toBe(false)
    expect(result.value.notice.kind).toBe('registered')
    expect(result.value.candidate.title).toBe('Cloudflare Workers の CPU 制限')
    expect(result.value.candidate.publishedAt).toBe('2026-03-01T00:00:00.000Z')
    expect(result.value.candidate.fullTextState).toBe('confirmed_free')
    expect(result.value.candidate.listingState).toBe('listed')
    expect(result.value.candidate.completedArticleId).toBeNull()
    const discoveries = await store.listDiscoveries(result.value.candidate.id)
    expect(discoveries).toHaveLength(1)
    expect(discoveries[0]?.sourceKind).toBe('manual_url')
  })

  it('dedupes by redirect final URL and canonical, and records a second discovery path', async () => {
    const store = createMemoryCandidateStore()
    const fetchPage = fetchHtml({
      'https://blog.example.com/alias': {
        html: html('candidate-canonical.html'),
        finalUrl: 'https://blog.example.com/alias-final',
      },
      'https://blog.example.com/other-alias': {
        html: html('candidate-canonical.html'),
        finalUrl: 'https://blog.example.com/other-final',
      },
    })
    const first = await registerCandidate(mustUrl('https://blog.example.com/alias'), { store, fetchPage })
    const second = await registerCandidate(mustUrl('https://blog.example.com/other-alias'), { store, fetchPage })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      return
    }
    expect(second.value.duplicate).toBe(true)
    expect(second.value.candidate.id).toBe(first.value.candidate.id)
    expect(second.value.candidate.canonicalUrl).toBe('https://blog.example.com/canonical-article')
    const discoveries = await store.listDiscoveries(first.value.candidate.id)
    expect(discoveries.map((row) => row.discoveredUrl).sort()).toEqual([
      'https://blog.example.com/alias',
      'https://blog.example.com/other-alias',
    ])
    expect(discoveries.every((row) => row.sourceKind === 'manual_url')).toBe(true)
    const listed = await store.listListed({ limit: 10, offset: 0 })
    expect(listed.total).toBe(1)
  })

  it('keeps unknown publishedAt instead of substituting discoveredAt', async () => {
    const store = createMemoryCandidateStore()
    const result = await registerCandidate(mustUrl('https://notes.example.com/undated'), {
      store,
      fetchPage: fetchHtml({
        'https://notes.example.com/undated': { html: html('candidate-no-date.html') },
      }),
      now: () => new Date('2026-09-21T03:00:00.000Z'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.candidate.publishedAt).toBeNull()
    expect(result.value.candidate.discoveredAt).toBe('2026-09-21T03:00:00.000Z')
    expect(result.value.candidate.fullTextState).toBe('confirmed_free')
  })

  it('stores fetch failures as listed candidates without claiming full text', async () => {
    const store = createMemoryCandidateStore()
    const result = await registerCandidate(mustUrl('https://missing.example.com/gone'), {
      store,
      fetchPage: async (url) => err({ kind: 'fetch_failed', url, reason: 'HTTP 404' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.notice.kind).toBe('fetch_failed')
    expect(result.value.candidate.fetchStatus).toBe('fetch_failed')
    expect(result.value.candidate.listingState).toBe('listed')
    expect(result.value.candidate.fullTextState).toBe('unconfirmed')
    const listed = await store.listListed({ limit: 10, offset: 0 })
    expect(listed.total).toBe(1)
  })

  it('excludes paywalled articles from the reading list and tells the submitter', async () => {
    const store = createMemoryCandidateStore()
    const result = await registerCandidate(mustUrl('https://paywall.example.com/essay'), {
      store,
      fetchPage: fetchHtml({
        'https://paywall.example.com/essay': { html: html('candidate-paywall.html') },
      }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.notice.kind).toBe('paywalled')
    expect(result.value.candidate.listingState).toBe('excluded')
    expect(result.value.candidate.exclusionReason).toBe('paywalled')
    expect(result.value.candidate.fullTextState).toBe('unavailable')
    const listed = await store.listListed({ limit: 10, offset: 0 })
    expect(listed.total).toBe(0)
  })

  it('rejects blocked hosts without storing them', async () => {
    const store = createMemoryCandidateStore()
    const result = await registerCandidate(mustUrl('http://127.0.0.1/secret'), {
      store,
      fetchPage: async () => {
        throw new Error('must not fetch')
      },
    })
    expect(result.ok).toBe(false)
    const listed = await store.listListed({ limit: 10, offset: 0 })
    expect(listed.total).toBe(0)
  })
})

describe('published date grouping', () => {
  it('splits JST midnight without using discoveredAt for unknown dates', () => {
    const base = {
      sourceUrl: mustUrl('https://example.com/a'),
      canonicalUrl: mustUrl('https://example.com/a'),
      title: 't',
      outlet: 'o',
      fetchStatus: 'fetched' as const,
      listingState: 'listed' as const,
      exclusionReason: null,
      fullTextState: 'unconfirmed' as const,
      completedArticleId: null,
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    }
    const before: CandidateArticle = {
      ...base,
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'),
      publishedAt: '2026-09-20T14:59:59.000Z',
      discoveredAt: '2026-09-22T00:00:00.000Z',
    }
    const after: CandidateArticle = {
      ...base,
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2'),
      canonicalUrl: mustUrl('https://example.com/b'),
      sourceUrl: mustUrl('https://example.com/b'),
      publishedAt: '2026-09-20T15:00:00.000Z',
      discoveredAt: '2026-09-22T00:00:00.000Z',
    }
    const unknown: CandidateArticle = {
      ...base,
      id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3'),
      canonicalUrl: mustUrl('https://example.com/c'),
      sourceUrl: mustUrl('https://example.com/c'),
      publishedAt: null,
      discoveredAt: '2026-09-20T15:00:00.000Z',
    }
    expect(calendarDateInTimeZone('2026-09-20T14:59:59.000Z', 'Asia/Tokyo')).toBe('2026-09-20')
    expect(calendarDateInTimeZone('2026-09-20T15:00:00.000Z', 'Asia/Tokyo')).toBe('2026-09-21')
    const groups = groupCandidatesByPublishedDate([after, before, unknown], 'Asia/Tokyo')
    expect(groups.map((group) => group.date)).toEqual(['2026-09-21', '2026-09-20', null])
    expect(groups[2]?.label).toBe('公開日不明')
    expect(groups[2]?.items[0]?.publishedAt).toBeNull()
    expect(groups[2]?.items[0]?.discoveredAt).toBe('2026-09-20T15:00:00.000Z')
  })

  it('pages listed candidates', async () => {
    const store = createMemoryCandidateStore()
    const now = '2026-09-21T00:00:00.000Z'
    for (let i = 0; i < 21; i += 1) {
      const id = asCandidateId(`cand_${i.toString().padStart(32, '0')}`)
      const url = mustUrl(`https://example.com/p/${i}`)
      await store.put({
        id,
        canonicalUrl: url,
        sourceUrl: url,
        title: `Article ${i}`,
        outlet: 'Example',
        publishedAt: `2026-09-${String(21 - Math.floor(i / 10)).padStart(2, '0')}T00:00:00.000Z`,
        discoveredAt: now,
        fetchStatus: 'fetched',
        listingState: 'listed',
        exclusionReason: null,
        fullTextState: 'unconfirmed',
        completedArticleId: null,
        createdAt: now,
        updatedAt: now,
      })
    }
    const first = await store.listListed({ limit: 20, offset: 0 })
    const second = await store.listListed({ limit: 20, offset: 20 })
    expect(first.total).toBe(21)
    expect(first.items).toHaveLength(20)
    expect(second.items).toHaveLength(1)
  })
})
