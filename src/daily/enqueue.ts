import { logDigestSchedule } from '../log'
import { DAILY_DIGEST_CRON, type DailyDigestQueuedBody, type DigestQueueMessage } from '../types'
import { dailyDateFromInstant } from './identity'

export type EnqueueDailyDigestDeps = {
  readonly digestQueue?: Queue<DigestQueueMessage>
  readonly cron?: string
  readonly now?: () => Date
}

export type EnqueueDailyDigestResult = {
  readonly cron: string
  readonly date: string
  readonly queued: number
  readonly failed: number
}

export async function enqueueDailyDigest(
  env: Cloudflare.Env,
  deps: EnqueueDailyDigestDeps = {},
): Promise<EnqueueDailyDigestResult> {
  const started = Date.now()
  const date = dailyDateFromInstant((deps.now ?? (() => new Date()))())
  const queue = deps.digestQueue ?? env.DIGEST_QUEUE
  let queued = 0
  let failed = 0
  try {
    await queue.send({ date })
    queued = 1
  } catch {
    failed = 1
  }
  const summary = {
    cron: deps.cron ?? DAILY_DIGEST_CRON,
    date,
    queued,
    failed,
  }
  logDigestSchedule({ ...summary, durationMs: Date.now() - started })
  return summary
}

export function toDailyDigestQueuedBody(date: string): DailyDigestQueuedBody {
  return { date, status: 'queued' }
}
