export const FEED_FAILURE_POINTS = ['fetch', 'parse', 'store', 'unknown'] as const

export type FeedFailurePoint = (typeof FEED_FAILURE_POINTS)[number]

export type FeedStage = Exclude<FeedFailurePoint, 'unknown'>

const FEED_STAGES = ['fetch', 'parse', 'store'] as const satisfies readonly FeedStage[]

export function isFeedFailurePoint(value: unknown): value is FeedFailurePoint {
  return typeof value === 'string' && (FEED_FAILURE_POINTS as readonly string[]).includes(value)
}

function isFeedStage(value: unknown): value is FeedStage {
  return typeof value === 'string' && (FEED_STAGES as readonly string[]).includes(value)
}

export class FeedStageError extends Error {
  readonly failurePoint: FeedStage
  override readonly name = 'FeedStageError'

  constructor(failurePoint: FeedStage) {
    super('Feed collection failed')
    this.failurePoint = failurePoint
  }
}

export function normalizeFeedFailurePoint(value: unknown): FeedFailurePoint {
  return isFeedFailurePoint(value) ? value : 'unknown'
}

export function feedFailurePoint(error: unknown): FeedFailurePoint {
  if (error instanceof FeedStageError && isFeedStage(error.failurePoint)) {
    return error.failurePoint
  }
  return 'unknown'
}

// The caught value may carry a URL, body, or secret in its message. Keep it off the replacement.
export async function runFeedStage<T>(stage: FeedStage, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof FeedStageError) {
      throw error
    }
    throw new FeedStageError(stage)
  }
}
