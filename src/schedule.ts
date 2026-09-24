import { runScheduledFeedCollection, type ScheduledFeedCollectionDeps } from './feeds/schedule'
import { enqueueDailyDigest, type EnqueueDailyDigestDeps } from './daily/enqueue'
import { DAILY_DIGEST_CRON, FEED_COLLECT_CRON } from './types'

export type ScheduledKind = 'feed_collect' | 'daily_digest'

export type HandleScheduledDeps = ScheduledFeedCollectionDeps & EnqueueDailyDigestDeps

export type HandleScheduledResult = {
  readonly kinds: readonly ScheduledKind[]
  readonly cron: string
  readonly queued: number
  readonly failed: number
}

export function scheduledKinds(
  cron: string,
  schedules: { readonly feedCollect: string; readonly dailyDigest: string } = {
    feedCollect: FEED_COLLECT_CRON,
    dailyDigest: DAILY_DIGEST_CRON,
  },
): readonly ScheduledKind[] {
  const kinds: ScheduledKind[] = []
  if (cron === schedules.feedCollect) {
    kinds.push('feed_collect')
  }
  if (cron === schedules.dailyDigest) {
    kinds.push('daily_digest')
  }
  return kinds
}

export async function handleScheduled(
  controller: { readonly cron: string },
  env: Cloudflare.Env,
  deps: HandleScheduledDeps = {},
): Promise<HandleScheduledResult> {
  const kinds = scheduledKinds(controller.cron)
  if (kinds.length === 0) {
    return { kinds, cron: controller.cron, queued: 0, failed: 0 }
  }

  let queued = 0
  let failed = 0
  for (const kind of kinds) {
    const result =
      kind === 'feed_collect'
        ? await runScheduledFeedCollection(env, { ...deps, cron: controller.cron })
        : await enqueueDailyDigest(env, { ...deps, cron: controller.cron })
    queued += result.queued
    failed += result.failed
  }
  return { kinds, cron: controller.cron, queued, failed }
}
