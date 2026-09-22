import { logFeedSchedule } from '../log'
import { createD1FeedSourceStore } from '../store/d1-sources'
import { FEED_COLLECT_CRON, type FeedQueueMessage, type FeedSourceStore } from '../types'
import { enqueueEnabledCollections } from './enqueue'

export type ScheduledFeedCollectionDeps = {
  readonly sourceStore?: FeedSourceStore
  readonly feedQueue?: Queue<FeedQueueMessage>
  readonly cron?: string
}

export type ScheduledFeedCollectionResult = {
  readonly cron: string
  readonly queued: number
  readonly failed: number
}

export async function runScheduledFeedCollection(
  env: Cloudflare.Env,
  deps: ScheduledFeedCollectionDeps = {},
): Promise<ScheduledFeedCollectionResult> {
  const started = Date.now()
  const result = await enqueueEnabledCollections({
    store: deps.sourceStore ?? createD1FeedSourceStore(env),
    queue: deps.feedQueue ?? env.FEED_QUEUE,
    now: () => new Date(),
  })
  const summary = {
    cron: deps.cron ?? FEED_COLLECT_CRON,
    queued: result.runs.length,
    failed: result.failures.length,
  }
  logFeedSchedule({ ...summary, durationMs: Date.now() - started })
  return summary
}
