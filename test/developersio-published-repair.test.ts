import { describe, expect, it } from 'vitest'
import { compareListedByPublishedDate } from '../src/candidates/list'
import {
  repairDevelopersIoPublishedDates,
  type DevelopersIoPublishedRepairStore,
  type DevelopersIoRepairCandidate,
} from '../src/candidates/repair-developersio-published'
import { asCandidateId, err, ok, parseHttpUrl, type CandidateId, type FetchPage, type HttpUrl } from '../src/types'
import {
  DEVELOPERS_IO_ARTICLE_URL,
  DEVELOPERS_IO_PUBLISHED_AT,
  developersIoArticleHtml,
} from './developersio-fixture'

function mustUrl(value: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function id(hex: string): CandidateId {
  return asCandidateId(`cand_${hex.padStart(32, '0')}`)
}

type Stored = {
  readonly id: CandidateId
  readonly canonicalUrl: HttpUrl
  publishedAt: string | null
  readonly discoveredAt: string
}

function memoryRepairStore(rows: readonly Stored[]): DevelopersIoPublishedRepairStore & {
  readonly rows: Stored[]
  complete: boolean
} {
  const stored = rows.map((row) => ({ ...row }))
  const repaired = new Set<string>()
  const state = {
    rows: stored,
    complete: false,
    async isComplete() {
      return state.complete
    },
    async listPending(): Promise<readonly DevelopersIoRepairCandidate[]> {
      return stored
        .filter((row) => row.canonicalUrl.includes('://dev.classmethod.jp/') && !repaired.has(row.id))
        .map((row) => ({ id: row.id, canonicalUrl: row.canonicalUrl }))
    },
    async writePublishedAt(candidateId: CandidateId, publishedAt: string | null) {
      const row = stored.find((item) => item.id === candidateId)
      if (row === undefined) {
        throw new Error(`missing ${candidateId}`)
      }
      row.publishedAt = publishedAt
      repaired.add(candidateId)
    },
    async markComplete() {
      state.complete = true
    },
  }
  return state
}

describe('DevelopersIO published date repair', () => {
  it('replaces stored event dates and clears rows whose article date cannot be determined', async () => {
    const article = mustUrl(DEVELOPERS_IO_ARTICLE_URL)
    const undated = mustUrl('https://dev.classmethod.jp/articles/no-date/')
    const other = mustUrl('https://example.com/older')
    const failed = mustUrl('https://dev.classmethod.jp/articles/missing/')
    const store = memoryRepairStore([
      {
        id: id('a'),
        canonicalUrl: article,
        publishedAt: '2026-10-27T06:00:00.000Z',
        discoveredAt: '2026-09-28T00:00:00.000Z',
      },
      {
        id: id('b'),
        canonicalUrl: undated,
        publishedAt: '2026-10-16T00:00:00.000Z',
        discoveredAt: '2026-09-28T00:00:00.000Z',
      },
      {
        id: id('c'),
        canonicalUrl: other,
        publishedAt: '2026-09-20T00:00:00.000Z',
        discoveredAt: '2026-09-20T00:00:00.000Z',
      },
      {
        id: id('d'),
        canonicalUrl: failed,
        publishedAt: '2026-10-24T00:00:00.000Z',
        discoveredAt: '2026-09-28T00:00:00.000Z',
      },
    ])
    const fetched: string[] = []
    const fetchPage: FetchPage = async (url) => {
      fetched.push(url)
      if (url === article) {
        return ok({
          requestedUrl: url,
          finalUrl: url,
          contentType: 'text/html',
          html: developersIoArticleHtml(),
        })
      }
      if (url === undated) {
        return ok({
          requestedUrl: url,
          finalUrl: url,
          contentType: 'text/html',
          html: developersIoArticleHtml({ articleDate: null }),
        })
      }
      return err({ kind: 'fetch_failed', url, reason: 'HTTP 404' })
    }

    const first = await repairDevelopersIoPublishedDates({
      store,
      fetchPage,
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    })
    expect(first.alreadyComplete).toBe(false)
    expect(first).toMatchObject({ examined: 3, dated: 1, cleared: 2 })
    expect(fetched).toEqual([article, undated, failed])
    expect(store.rows.find((row) => row.id === id('a'))?.publishedAt).toBe(DEVELOPERS_IO_PUBLISHED_AT)
    expect(store.rows.find((row) => row.id === id('b'))?.publishedAt).toBeNull()
    expect(store.rows.find((row) => row.id === id('d'))?.publishedAt).toBeNull()
    expect(store.rows.find((row) => row.id === id('c'))?.publishedAt).toBe('2026-09-20T00:00:00.000Z')

    const ordered = [...store.rows].sort(compareListedByPublishedDate)
    expect(ordered.slice(0, 2).map((row) => row.id)).toEqual([id('a'), id('c')])
    expect(ordered.slice(2).every((row) => row.publishedAt === null)).toBe(true)
    expect(ordered[0]?.publishedAt).toBe(DEVELOPERS_IO_PUBLISHED_AT)

    fetched.length = 0
    const second = await repairDevelopersIoPublishedDates({
      store,
      fetchPage,
      now: () => new Date('2026-09-30T01:00:00.000Z'),
    })
    expect(second.alreadyComplete).toBe(true)
    expect(fetched).toEqual([])

    store.rows.push({
      id: id('e'),
      canonicalUrl: mustUrl('https://dev.classmethod.jp/articles/later/'),
      publishedAt: '2026-11-01T00:00:00.000Z',
      discoveredAt: '2026-09-30T02:00:00.000Z',
    })
    await repairDevelopersIoPublishedDates({
      store,
      fetchPage,
      now: () => new Date('2026-09-30T03:00:00.000Z'),
    })
    expect(fetched).toEqual([])
    expect(store.rows.find((row) => row.id === id('e'))?.publishedAt).toBe('2026-11-01T00:00:00.000Z')
  })
})
