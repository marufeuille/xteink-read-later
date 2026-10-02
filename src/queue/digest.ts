import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import {
  DIGEST_QUEUE_MAX_RETRIES,
  shouldRetryDigestAttempt,
} from '../daily/budget'
import { parseDigestQueueMessage, processDigestDelivery } from '../daily/deliver'
import type { RunDailyDigestDeps } from '../daily/deps'
import type { DigestQueueMessage, FetchPage } from '../types'

export { DIGEST_QUEUE_MAX_RETRIES, shouldRetryDigestAttempt, parseDigestQueueMessage }

export const DIGEST_QUEUE_NAME = 'xteink-read-later-digest'

export type DigestQueueHandlerDeps = Omit<RunDailyDigestDeps, 'fetchPage'> & {
  readonly fetchPage?: FetchPage
}

async function processMessage(
  message: Message<DigestQueueMessage>,
  env: Cloudflare.Env,
  deps: DigestQueueHandlerDeps,
): Promise<void> {
  const outcome = await processDigestDelivery(
    env,
    { ...deps, fetchPage: deps.fetchPage ?? defaultFetchPage },
    message.body,
    message.attempts,
    { scheduleWatchdog: true },
  )
  if (outcome.action === 'retry') {
    message.retry()
    return
  }
  const queue = env.DIGEST_QUEUE
  try {
    for (const item of outcome.enqueue) {
      await queue.send(item.body, item.delaySeconds === undefined ? undefined : { delaySeconds: item.delaySeconds })
    }
  } catch {
    message.retry()
    return
  }
  message.ack()
}

export function createDigestQueueHandler(
  deps: DigestQueueHandlerDeps = {},
): (batch: MessageBatch<DigestQueueMessage>, env: Cloudflare.Env) => Promise<void> {
  return async (batch, env) => {
    for (const message of batch.messages) {
      await processMessage(message, env, deps)
    }
  }
}
