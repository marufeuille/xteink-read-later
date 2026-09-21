import {
  CANDIDATE_LIST_FILTER_MAX_LENGTH,
  EMPTY_CANDIDATE_LIST_FILTERS,
  isCandidateListGradeFilter,
  type CandidateArticle,
  type CandidateListFilters,
} from '../types'

type ParsedListLocation = {
  readonly filters: CandidateListFilters
  readonly page: number
}

export function parseListPage(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 1
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1
  }
  return parsed
}

function clipFilter(value: string | null | undefined, max = CANDIDATE_LIST_FILTER_MAX_LENGTH): string {
  if (value === undefined || value === null) {
    return ''
  }
  return value.trim().slice(0, max)
}

export function parseCandidateListFilters(
  input:
    | {
        readonly title?: string | undefined
        readonly grade?: string | undefined
        readonly outlet?: string | undefined
      }
    | URLSearchParams,
): CandidateListFilters {
  const fields =
    input instanceof URLSearchParams
      ? { title: input.get('title'), grade: input.get('grade'), outlet: input.get('outlet') }
      : input
  const gradeRaw = clipFilter(fields.grade)
  return {
    title: clipFilter(fields.title),
    grade: isCandidateListGradeFilter(gradeRaw) ? gradeRaw : '',
    outlet: clipFilter(fields.outlet),
  }
}

export function candidateListFiltersActive(filters: CandidateListFilters): boolean {
  return filters.title !== '' || filters.grade !== '' || filters.outlet !== ''
}

export function uniqueListedOutlets(articles: readonly CandidateArticle[]): readonly string[] {
  return [
    ...new Set(
      articles
        .filter((article) => article.listingState === 'listed' && article.outlet !== '')
        .map((article) => article.outlet),
    ),
  ].sort((a, b) => a.localeCompare(b, 'ja'))
}

export function likeContains(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

export function candidateMatchesListFilters(
  article: CandidateArticle,
  filters: CandidateListFilters,
): boolean {
  if (article.listingState !== 'listed') {
    return false
  }
  if (filters.title !== '' && !article.title.toLowerCase().includes(filters.title.toLowerCase())) {
    return false
  }
  if (filters.outlet !== '' && article.outlet.toLowerCase() !== filters.outlet.toLowerCase()) {
    return false
  }
  if (filters.grade === 'pending') {
    return article.recommendation.status !== 'evaluated'
  }
  if (filters.grade !== '') {
    return article.recommendation.status === 'evaluated' && article.recommendation.grade === filters.grade
  }
  return true
}

export function listedFilterSql(
  filters: CandidateListFilters,
): { readonly where: string; readonly binds: readonly unknown[] } {
  const clauses = ['listing_state = ?']
  const binds: unknown[] = ['listed']
  if (filters.title !== '') {
    clauses.push(`LOWER(title) LIKE LOWER(?) ESCAPE '\\'`)
    binds.push(likeContains(filters.title))
  }
  if (filters.outlet !== '') {
    clauses.push('outlet = ? COLLATE NOCASE')
    binds.push(filters.outlet)
  }
  if (filters.grade === 'pending') {
    clauses.push('recommend_status != ?')
    binds.push('evaluated')
  } else if (filters.grade !== '') {
    clauses.push('recommend_status = ? AND recommend_grade = ?')
    binds.push('evaluated', filters.grade)
  }
  return { where: clauses.join(' AND '), binds }
}

function candidateListParams(
  filters: CandidateListFilters,
  page = 1,
  notice?: string,
): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.title !== '') {
    params.set('title', filters.title)
  }
  if (filters.grade !== '') {
    params.set('grade', filters.grade)
  }
  if (filters.outlet !== '') {
    params.set('outlet', filters.outlet)
  }
  if (page > 1) {
    params.set('page', String(page))
  }
  if (notice !== undefined && notice !== '') {
    params.set('notice', notice)
  }
  return params
}

export function formatCandidatesPath(
  filters: CandidateListFilters,
  page = 1,
  notice?: string,
): string {
  const query = candidateListParams(filters, page, notice).toString()
  return query === '' ? '/candidates' : `/candidates?${query}`
}

export function candidatesReturnToQuery(filters: CandidateListFilters, page: number): string {
  return candidateListParams(filters, page).toString()
}

function locationFromParams(params: URLSearchParams): ParsedListLocation {
  return {
    filters: parseCandidateListFilters(params),
    page: parseListPage(params.get('page') ?? undefined),
  }
}

function parseCandidatesListLocation(raw: string | undefined): ParsedListLocation | null {
  if (raw === undefined || raw.trim() === '') {
    return null
  }
  try {
    const url = new URL(raw, 'https://xteink.invalid')
    if (url.pathname !== '/candidates' && url.pathname !== '/candidates/') {
      return null
    }
    return locationFromParams(url.searchParams)
  } catch {
    return null
  }
}

function parseCandidatesReturnTo(raw: string | undefined): ParsedListLocation | null {
  if (raw === undefined || raw.trim() === '') {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return parseCandidatesListLocation(trimmed)
  }
  return locationFromParams(new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed))
}

export function candidatesLocation(input: {
  readonly returnTo?: string | undefined
  readonly referer?: string | undefined
  readonly notice?: string | undefined
}): string {
  const parsed = parseCandidatesReturnTo(input.returnTo) ?? parseCandidatesListLocation(input.referer)
  const filters = parsed?.filters ?? EMPTY_CANDIDATE_LIST_FILTERS
  const page = parsed?.page ?? 1
  return formatCandidatesPath(filters, page, input.notice)
}
