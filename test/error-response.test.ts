import { describe, expect, it } from 'vitest'
import { errorMessage, toErrorBody, toErrorResponse, toTranslateFailedBody } from '../src/http/error-response'
import { parseHttpUrl, type ExtractedArticle } from '../src/types'

function url() {
  const parsed = parseHttpUrl('https://example.com/a')
  if (parsed === null) {
    throw new Error('url')
  }
  return parsed
}

const extracted: ExtractedArticle = {
  title: 'Dummy title',
  author: null,
  publishedAt: null,
  sourceUrl: url(),
  canonicalUrl: url(),
  contentHtml: '<p>dummy extracted body</p>',
  language: 'non-ja',
}

describe('error-response', () => {
  it('maps extract_failed to 422 and epub_failed to 500', async () => {
    const extract = toErrorResponse({
      kind: 'extract_failed',
      url: url(),
      reason: 'no article',
    })
    expect(extract.status).toBe(422)
    expect(await extract.json()).toEqual({
      error: {
        status: 422,
        code: 'extract_failed',
        message: errorMessage({ kind: 'extract_failed', url: url(), reason: 'no article' }),
      },
    })

    const epub = toErrorResponse({
      kind: 'epub_failed',
      url: url(),
      reason: 'EPUB generation failed: zip boom',
    })
    expect(epub.status).toBe(500)
    const epubBody = (await epub.json()) as { error: { code: string } }
    expect(epubBody.error.code).toBe('epub_failed')
    expect(toErrorBody({ kind: 'epub_failed', url: url(), reason: 'zip boom' }).error.status).toBe(500)
  })

  it('keeps extracted article only on translate_failed', async () => {
    const body = toTranslateFailedBody({
      kind: 'translate_failed',
      extracted,
      reason: 'OpenAI HTTP 500',
    })
    expect(body.error.status).toBe(503)
    expect(body.error.code).toBe('translate_failed')
    expect(body.error.extracted).toEqual(extracted)

    const response = toErrorResponse({
      kind: 'translate_failed',
      extracted,
      reason: 'OpenAI HTTP 500',
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as typeof body).error.extracted.contentHtml).toContain('dummy extracted body')
  })

  it('covers the remaining HTTP error kinds', () => {
    expect(toErrorBody({ kind: 'invalid_url', url: '' }).error.status).toBe(400)
    expect(toErrorBody({ kind: 'invalid_epub', reason: 'uploaded file is not an EPUB zip' }).error.status).toBe(
      400,
    )
    expect(toErrorBody({ kind: 'payload_too_large', bytes: 9 }).error.status).toBe(413)
    expect(toErrorBody({ kind: 'fetch_failed', url: url(), reason: 'HTTP 404' }).error.status).toBe(502)
    expect(toErrorBody({ kind: 'not_found' }).error.status).toBe(404)
    expect(toErrorBody({ kind: 'queue_failed', reason: 'queue unavailable' }).error.status).toBe(503)
    expect(toErrorBody({ kind: 'csrf_failed' }).error.status).toBe(403)
    expect(toErrorBody({ kind: 'invalid_feed', reason: 'not a feed', url: 'https://example.com/x' }).error.status).toBe(
      400,
    )
    expect(toErrorBody({ kind: 'source_disabled' }).error.status).toBe(409)
    expect(
      toErrorBody({ kind: 'candidate_unsendable', reason: 'paywalled' }).error.status,
    ).toBe(409)
    expect(errorMessage({ kind: 'queue_failed', reason: 'queue unavailable' })).toContain('queue unavailable')
    expect(errorMessage({ kind: 'unauthorized' })).toBe('Unauthorized')
    expect(errorMessage({ kind: 'csrf_failed' })).toBe('CSRF token mismatch')
    expect(errorMessage({ kind: 'invalid_feed', reason: 'not a feed', url: '' })).toBe('not a feed')
    expect(errorMessage({ kind: 'source_disabled' })).toBe('Source is stopped')
  })
})
