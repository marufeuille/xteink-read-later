import { fetchPage as defaultFetchPage } from '../extract/fetch-page'
import { runDailyDigest, type RunDailyDigestDeps } from '../daily/run'
import { parseDailyDate } from '../daily/identity'
import type { DigestQueueMessage, FetchPage } from '../types'

export const DIGEST_QUEUE_MAX_RETRIES = 3
export const DIGEST_QUEUE_NAME = 'xteink-read-later-digest'

export type DigestQueueHandlerDeps = Omit<RunDailyDigestDeps, 'fetchPage'> & {
  readonly fetchPage?: FetchPage
}

export function parseDigestQueueMessage(body: unknown): DigestQueueMessage | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  if (!('date' in body) || typeof body.date !== 'string') {
    return null
  }
  const date = parseDailyDate(body.date)
  return date === null ? null : { date }
}

export function shouldRetryDigestAttempt(attempts: number): boolean {
  return attempts <= DIGEST_QUEUE_MAX_RETRIES
}

async function processMessage(
  message: Message<DigestQueueMessage>,
  env: Cloudflare.Env,
  deps: DigestQueueHandlerDeps,
): Promise<void> {
  const parsed = parseDigestQueueMessage(message.body)
  if (parsed === null) {
    message.ack()
    return
  }
  const result = await runDailyDigest(env, {
    ...deps,
    fetchPage: deps.fetchPage ?? defaultFetchPage,
    date: parsed.date,
  })
  if (result.status === 'failed' && shouldRetryDigestAttempt(message.attempts)) {
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
