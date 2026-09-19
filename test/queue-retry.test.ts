import { describe, expect, it } from 'vitest'
import {
  CLIP_QUEUE_MAX_RETRIES,
  parseClipQueueMessage,
  shouldRetryClipError,
} from '../src/queue/clip'
import { asClipJobId, parseHttpUrl } from '../src/types'

function url() {
  const parsed = parseHttpUrl('https://example.com/a')
  if (parsed === null) {
    throw new Error('url')
  }
  return parsed
}

describe('clip queue retry', () => {
  it('retries translate_failed and fetch_failed until the last attempt', () => {
    expect(shouldRetryClipError('translate_failed', 1)).toBe(true)
    expect(shouldRetryClipError('fetch_failed', CLIP_QUEUE_MAX_RETRIES)).toBe(true)
    expect(shouldRetryClipError('translate_failed', CLIP_QUEUE_MAX_RETRIES + 1)).toBe(false)
  })

  it('retries epub_failed once, then fails', () => {
    expect(shouldRetryClipError('epub_failed', 1)).toBe(true)
    expect(shouldRetryClipError('epub_failed', 2)).toBe(false)
  })

  it('does not retry extract_failed or payload_too_large', () => {
    expect(shouldRetryClipError('extract_failed', 1)).toBe(false)
    expect(shouldRetryClipError('payload_too_large', 1)).toBe(false)
    expect(shouldRetryClipError('invalid_url', 1)).toBe(false)
  })

  it('accepts {jobId,url} only and ignores extra keys', () => {
    const jobId = asClipJobId('job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const parsed = parseClipQueueMessage({
      jobId,
      url: url(),
      extra: 'must-not-be-required',
    })
    expect(parsed).toEqual({ jobId, url: url() })
    expect(parseClipQueueMessage({ jobId, url: 'ftp://example.com/x' })).toBeNull()
    expect(parseClipQueueMessage({ url: url() })).toBeNull()
  })
})
