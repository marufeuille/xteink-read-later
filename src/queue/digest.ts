import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import {
  DIGEST_QUEUE_MAX_RETRIES,
  shouldRetryDigestAttempt,
} from '../daily/budget'
import { parseDigestQueueMessage, processDigestDelivery } from '../daily/deliver'
import type { RunDailyDigestDeps } from '../daily/deps'
import {
  CRONITOR_DAILY_DIGEST_FAIL_MESSAGE,
  CRONITOR_DAILY_DIGEST_MONITOR_KEY_BINDING,
  traceCronitorJob,
} from '../telemetry/cronitor'
import type { DigestQueueMessage, DigestRunResult, FetchPage } from '../types'

export { DIGEST_QUEUE_MAX_RETRIES, shouldRetryDigestAttempt, parseDigestQueueMessage }

export const DIGEST_QUEUE_NAME = 'xteink-read-later-digest'

export type DigestQueueHandlerDeps = Omit<RunDailyDigestDeps, 'fetchPage'> & {
  readonly fetchPage?: FetchPage
  readonly cronitorFetch?: typeof fetch
}

async function processMessage(
  message: Message<DigestQueueMessage>,
  env: Cloudflare.Env,
  deps: DigestQueueHandlerDeps,
): Promise<DigestRunResult | null> {
  const outcome = await processDigestDelivery(
    env,
    { ...deps, fetchPage: deps.fetchPage ?? defaultFetchPage },
    message.body,
    message.attempts,
    { scheduleWatchdog: true },
  )
  if (outcome.action === 'retry') {
    message.retry()
    return outcome.decided
  }
  const queue = env.DIGEST_QUEUE
  try {
    for (const item of outcome.enqueue) {
      await queue.send(item.body, item.delaySeconds === undefined ? undefined : { delaySeconds: item.delaySeconds })
    }
  } catch {
    message.retry()
    return outcome.decided
  }
  message.ack()
  return outcome.decided
}

async function traceDigestRun(
  env: Cloudflare.Env,
  deps: DigestQueueHandlerDeps,
  result: DigestRunResult,
): Promise<void> {
  await traceCronitorJob({
    env,
    monitorKeyBinding: CRONITOR_DAILY_DIGEST_MONITOR_KEY_BINDING,
    failMessage: CRONITOR_DAILY_DIGEST_FAIL_MESSAGE,
    ...(deps.cronitorFetch === undefined ? {} : { fetch: deps.cronitorFetch }),
    job: async () => result,
    metrics: () => ({
      count: 1,
      error_count: result.status === 'failed' ? 1 : 0,
    }),
    failed: () => result.status === 'failed',
  })
}

export function createDigestQueueHandler(
  deps: DigestQueueHandlerDeps = {},
): (batch: MessageBatch<DigestQueueMessage>, env: Cloudflare.Env) => Promise<void> {
  return async (batch, env) => {
    for (const message of batch.messages) {
      const decided = await processMessage(message, env, deps)
      // Steps still in progress do not ping. One run/complete pair is the terminal status.
      if (decided !== null) {
        await traceDigestRun(env, deps, decided)
      }
    }
  }
}
