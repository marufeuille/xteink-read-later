import { createDigestQueueHandler, type DigestQueueHandlerDeps } from '../src/queue/digest'
import type { DigestQueueMessage } from '../src/types'

const EMPTY_METRICS = { backlogCount: 0, backlogBytes: 0 }

type Pending = {
  body: DigestQueueMessage
  attempts: number
  availableAt: number
}

export type FakeDigestQueue = Queue<DigestQueueMessage> & {
  readonly size: number
  readonly delayedSize: number
  peek(): readonly DigestQueueMessage[]
  push(body: DigestQueueMessage, attempts?: number): void
  drain(env: Cloudflare.Env, deps?: DigestQueueHandlerDeps): Promise<void>
}

export function createFakeDigestQueue(
  options: {
    onSend?: (message: DigestQueueMessage, sendOptions?: { delaySeconds?: number }) => void | Promise<void>
  } = {},
): FakeDigestQueue {
  const pending: Pending[] = []
  const sendResponse = {
    metadata: { metrics: { ...EMPTY_METRICS } },
  }

  const queue: FakeDigestQueue = {
    get size() {
      return pending.length
    },
    get delayedSize() {
      const now = Date.now()
      return pending.filter((item) => item.availableAt > now).length
    },
    peek() {
      return pending.map((item) => item.body)
    },
    push(body, attempts = 1) {
      pending.push({ body, attempts, availableAt: 0 })
    },
    async metrics() {
      return { backlogCount: pending.length, backlogBytes: 0 }
    },
    async send(message, sendOptions) {
      await options.onSend?.(message, sendOptions)
      const delaySeconds = sendOptions?.delaySeconds ?? 0
      pending.push({
        body: message,
        attempts: 1,
        availableAt: Date.now() + delaySeconds * 1000,
      })
      return sendResponse
    },
    async sendBatch(messages) {
      for (const item of messages) {
        const delaySeconds = item.delaySeconds ?? 0
        pending.push({
          body: item.body,
          attempts: 1,
          availableAt: Date.now() + delaySeconds * 1000,
        })
      }
      return sendResponse
    },
    async drain(env, deps = {}) {
      const handler = createDigestQueueHandler(deps)
      let guard = 0
      for (;;) {
        const now = Date.now()
        const ready: Pending[] = []
        const waiting: Pending[] = []
        for (const item of pending) {
          if (item.availableAt <= now) {
            ready.push(item)
          } else {
            waiting.push(item)
          }
        }
        pending.splice(0, pending.length, ...waiting)
        if (ready.length === 0) {
          return
        }
        guard += 1
        if (guard > 200) {
          throw new Error('digest queue drain exceeded 200 batches')
        }
        const retried: Pending[] = []
        const batch: MessageBatch<DigestQueueMessage> = {
          messages: ready.map((item, index) => ({
            id: `digest_msg_${guard}_${index}`,
            timestamp: new Date(),
            body: item.body,
            attempts: item.attempts,
            retry() {
              retried.push({ body: item.body, attempts: item.attempts + 1, availableAt: 0 })
            },
            ack() {},
          })),
          queue: 'xteink-read-later-digest',
          metadata: { metrics: { ...EMPTY_METRICS } },
          retryAll() {
            for (const message of this.messages) {
              message.retry()
            }
          },
          ackAll() {},
        }
        await handler(batch, env)
        pending.push(...retried)
      }
    },
  }

  return queue
}
