import { describe, expect, it } from 'vitest'
import {
  candidateMatchesListFilters,
  candidatesLocation,
  candidatesReturnToQuery,
  formatCandidatesPath,
  likeContains,
  listedFilterSql,
  parseCandidateListFilters,
  parseListPage,
  uniqueListedOutlets,
} from '../src/candidates/list-filter'
import { evaluatedRecommendation, unevaluatedRecommendation } from '../src/recommend/taxonomy'
import { asCandidateId, parseHttpUrl, type CandidateArticle } from '../src/types'

function mustUrl(value: string) {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(value)
  }
  return url
}

function article(input: {
  readonly title: string
  readonly outlet: string
  readonly grade?: 'recommended' | 'related' | 'low_priority'
  readonly listingState?: CandidateArticle['listingState']
}): CandidateArticle {
  const url = mustUrl('https://example.com/a')
  const now = '2026-09-21T00:00:00.000Z'
  return {
    id: asCandidateId('cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    canonicalUrl: url,
    sourceUrl: url,
    title: input.title,
    outlet: input.outlet,
    publishedAt: now,
    discoveredAt: now,
    fetchStatus: 'fetched',
    listingState: input.listingState ?? 'listed',
    exclusionReason: null,
    fullTextState: 'unconfirmed',
    completedArticleId: null,
    clipJobId: null,
    clipRunId: null,
    selectedAt: null,
    recommendation:
      input.grade === undefined
        ? unevaluatedRecommendation()
        : evaluatedRecommendation({
            grade: input.grade,
            confidence: 0.9,
            model: 'jev-test',
            excerptHash: 'hash',
            evaluatedAt: now,
            relevant: true,
            concrete: false,
            verification: false,
            inputTokens: 10,
            durationMs: 5,
          }),
    createdAt: now,
    updatedAt: now,
  }
}

describe('candidate list filters', () => {
  it('trims, truncates, and ignores unknown grades', () => {
    expect(parseCandidateListFilters({ title: '  Workers  ', grade: 'nope', outlet: ' Zenn ' })).toEqual({
      title: 'Workers',
      grade: '',
      outlet: 'Zenn',
    })
    expect(parseCandidateListFilters({ grade: 'related' }).grade).toBe('related')
    expect(parseListPage('2')).toBe(2)
    expect(parseListPage('0')).toBe(1)
  })

  it('matches title, outlet, and recommendation grade', () => {
    const workers = article({ title: 'Cloudflare Workers の CPU 制限', outlet: 'Example', grade: 'related' })
    const zenn = article({ title: 'データ基盤の設計', outlet: 'Zenn', grade: 'recommended' })
    const pending = article({ title: '未判定の記事', outlet: 'Qiita' })
    expect(candidateMatchesListFilters(workers, parseCandidateListFilters({ title: 'workers' }))).toBe(true)
    expect(candidateMatchesListFilters(zenn, parseCandidateListFilters({ title: 'workers' }))).toBe(false)
    expect(candidateMatchesListFilters(zenn, parseCandidateListFilters({ outlet: 'zenn' }))).toBe(true)
    expect(candidateMatchesListFilters(workers, parseCandidateListFilters({ outlet: 'zenn' }))).toBe(false)
    expect(candidateMatchesListFilters(zenn, parseCandidateListFilters({ grade: 'recommended' }))).toBe(true)
    expect(candidateMatchesListFilters(workers, parseCandidateListFilters({ grade: 'recommended' }))).toBe(false)
    expect(candidateMatchesListFilters(pending, parseCandidateListFilters({ grade: 'pending' }))).toBe(true)
    expect(candidateMatchesListFilters(zenn, parseCandidateListFilters({ grade: 'pending' }))).toBe(false)
    expect(
      candidateMatchesListFilters(workers, parseCandidateListFilters({ title: 'cpu', grade: 'related', outlet: 'Example' })),
    ).toBe(true)
  })

  it('does not match excluded articles', () => {
    const excluded = article({ title: 'Members only', outlet: 'Paywall', listingState: 'excluded' })
    expect(candidateMatchesListFilters(excluded, parseCandidateListFilters({ title: 'Members' }))).toBe(false)
  })

  it('builds LIKE patterns and SQL that bind user input', () => {
    expect(likeContains('a%b_c\\d')).toBe('%a\\%b\\_c\\\\d%')
    const sql = listedFilterSql(parseCandidateListFilters({ title: 'Workers', grade: 'related', outlet: 'Zenn' }))
    expect(sql.where).toContain('LOWER(title) LIKE LOWER(?)')
    expect(sql.where).toContain('recommend_status = ? AND recommend_grade = ?')
    expect(sql.binds).toEqual(['listed', '%Workers%', 'Zenn', 'evaluated', 'related'])
  })

  it('keeps unique outlets and list query strings', () => {
    expect(
      uniqueListedOutlets([
        article({ title: 'a', outlet: 'Zenn' }),
        article({ title: 'b', outlet: 'Example' }),
        article({ title: 'c', outlet: 'Zenn', listingState: 'excluded' }),
      ]),
    ).toEqual(['Example', 'Zenn'])
    expect(formatCandidatesPath(parseCandidateListFilters({ title: 'Workers' }), 2, 'clipped')).toBe(
      '/candidates?title=Workers&page=2&notice=clipped',
    )
    expect(candidatesReturnToQuery(parseCandidateListFilters({ outlet: 'Zenn' }), 1)).toBe('outlet=Zenn')
    expect(
      candidatesLocation({
        returnTo: '?title=Workers&page=2',
        notice: 'clipped',
      }),
    ).toBe('/candidates?title=Workers&page=2&notice=clipped')
    expect(
      candidatesLocation({
        referer: 'https://evil.example/candidates?title=Workers',
        notice: 'rejudged',
      }),
    ).toBe('/candidates?title=Workers&notice=rejudged')
    expect(
      candidatesLocation({
        referer: 'https://evil.example/other?title=Workers',
        notice: 'clipped',
      }),
    ).toBe('/candidates?notice=clipped')
    expect(
      candidatesLocation({
        returnTo: 'title=https://example.com/a',
        notice: 'clipped',
      }),
    ).toBe('/candidates?title=https%3A%2F%2Fexample.com%2Fa&notice=clipped')
  })
})
