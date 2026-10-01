import { logFeedSchedule } from '../log'
import { createD1FeedSourceStore } from '../store/d1-sources'
import {
  CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
  CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
  traceCronitorJob,
} from '../telemetry/cronitor'
import { FEED_COLLECT_CRON, type FeedQueueMessage, type FeedSourceStore } from '../types'
import { enqueueEnabledCollections } from './enqueue'

export type ScheduledFeedCollectionDeps = {
  readonly sourceStore?: FeedSourceStore
  readonly feedQueue?: Queue<FeedQueueMessage>
  readonly cron?: string
  readonly cronitorFetch?: typeof fetch
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
  return traceCronitorJob({
    env,
    monitorKeyBinding: CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING,
    failMessage: CRONITOR_FEED_COLLECT_FAIL_MESSAGE,
    ...(deps.cronitorFetch === undefined ? {} : { fetch: deps.cronitorFetch }),
    job: async () => {
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
    },
    metrics: (summary) => ({
      count: summary.queued + summary.failed,
      error_count: summary.failed,
    }),
    failed: (summary) => summary.failed > 0,
  })
}
