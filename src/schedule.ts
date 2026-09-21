import { runScheduledFeedCollection, type ScheduledFeedCollectionDeps } from './feeds/schedule'
import { enqueueDailyDigest, type EnqueueDailyDigestDeps } from './daily/enqueue'
import { DAILY_DIGEST_CRON, FEED_COLLECT_CRON } from './types'

export type ScheduledKind = 'feed_collect' | 'daily_digest'

export type HandleScheduledDeps = ScheduledFeedCollectionDeps & EnqueueDailyDigestDeps

export type HandleScheduledResult = {
  readonly kind: ScheduledKind | 'unknown'
  readonly cron: string
  readonly queued: number
  readonly failed: number
}

export function scheduledKind(cron: string): ScheduledKind | null {
  switch (cron) {
    case FEED_COLLECT_CRON:
      return 'feed_collect'
    case DAILY_DIGEST_CRON:
      return 'daily_digest'
    default:
      return null
  }
}

function scheduledResult(
  kind: ScheduledKind,
  result: { readonly cron: string; readonly queued: number; readonly failed: number },
): HandleScheduledResult {
  return { kind, cron: result.cron, queued: result.queued, failed: result.failed }
}

export async function handleScheduled(
  controller: { readonly cron: string },
  env: Cloudflare.Env,
  deps: HandleScheduledDeps = {},
): Promise<HandleScheduledResult> {
  const kind = scheduledKind(controller.cron)
  switch (kind) {
    case 'feed_collect':
      return scheduledResult(kind, await runScheduledFeedCollection(env, { ...deps, cron: controller.cron }))
    case 'daily_digest':
      return scheduledResult(kind, await enqueueDailyDigest(env, { ...deps, cron: controller.cron }))
    case null:
      return { kind: 'unknown', cron: controller.cron, queued: 0, failed: 0 }
  }
}
