import { afterEach, describe, expect, it, vi } from 'vitest'
import { logPipeline } from '../src/log'
import { asArticleId } from '../src/types'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('logPipeline', () => {
  it('writes stage JSON without book text', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logPipeline({
      articleId: asArticleId('art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      stage: 'epub',
      durationMs: 12,
      errorKind: 'epub_failed',
    })
    expect(spy).toHaveBeenCalledTimes(1)
    const line = String(spy.mock.calls[0]?.[0])
    const parsed = JSON.parse(line) as {
      event: string
      stage: string
      errorKind: string
      durationMs: number
    }
    expect(parsed).toEqual({
      event: 'pipeline',
      articleId: 'art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      stage: 'epub',
      durationMs: 12,
      errorKind: 'epub_failed',
    })
    expect(line).not.toContain('<p>')
    expect(line).not.toContain('chapter')
  })
})
