import { describe, expect, it } from 'vitest'
import {
  FEED_QUEUE_MAX_RETRIES,
  parseFeedQueueMessage,
  shouldRetryFeedAttempt,
  shouldRetryFeedError,
} from '../src/queue/feed'
import { asFeedRunId, asFeedSourceId } from '../src/types'

describe('feed queue retry', () => {
  it('retries fetch_failed until the last attempt and does not retry invalid feeds', () => {
    expect(shouldRetryFeedError('fetch_failed', 1)).toBe(true)
    expect(shouldRetryFeedError('fetch_failed', FEED_QUEUE_MAX_RETRIES)).toBe(true)
    expect(shouldRetryFeedError('fetch_failed', FEED_QUEUE_MAX_RETRIES + 1)).toBe(false)
    expect(shouldRetryFeedError('invalid_feed', 1)).toBe(false)
    expect(shouldRetryFeedError('payload_too_large', 1)).toBe(false)
    expect(shouldRetryFeedAttempt(FEED_QUEUE_MAX_RETRIES)).toBe(true)
    expect(shouldRetryFeedAttempt(FEED_QUEUE_MAX_RETRIES + 1)).toBe(false)
  })

  it('accepts {sourceId,runId} only', () => {
    const sourceId = asFeedSourceId('src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const runId = asFeedRunId('frun_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(parseFeedQueueMessage({ sourceId, runId, extra: true })).toEqual({ sourceId, runId })
    expect(parseFeedQueueMessage({ sourceId })).toBeNull()
    expect(parseFeedQueueMessage({ runId })).toBeNull()
    expect(parseFeedQueueMessage({ sourceId: 'src_bad', runId })).toBeNull()
  })
})
