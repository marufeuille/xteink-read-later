import { createDigestQueueHandler, type DigestQueueHandlerDeps } from '../src/queue/digest'
import type { DigestQueueMessage } from '../src/types'

const EMPTY_METRICS = { backlogCount: 0, backlogBytes: 0 }

type Pending = {
  body: DigestQueueMessage
  attempts: number
}

export type FakeDigestQueue = Queue<DigestQueueMessage> & {
  readonly size: number
  peek(): readonly DigestQueueMessage[]
  push(body: DigestQueueMessage, attempts?: number): void
  drain(env: Cloudflare.Env, deps?: DigestQueueHandlerDeps): Promise<void>
}

export function createFakeDigestQueue(
  options: { onSend?: (message: DigestQueueMessage) => void | Promise<void> } = {},
): FakeDigestQueue {
  const pending: Pending[] = []
  const sendResponse = {
    metadata: { metrics: { ...EMPTY_METRICS } },
  }

  const queue: FakeDigestQueue = {
    get size() {
      return pending.length
    },
    peek() {
      return pending.map((item) => item.body)
    },
    push(body, attempts = 1) {
      pending.push({ body, attempts })
    },
    async metrics() {
      return { backlogCount: pending.length, backlogBytes: 0 }
    },
    async send(message) {
      await options.onSend?.(message)
      pending.push({ body: message, attempts: 1 })
      return sendResponse
    },
    async sendBatch(messages) {
      for (const item of messages) {
        pending.push({ body: item.body, attempts: 1 })
      }
      return sendResponse
    },
    async drain(env, deps = {}) {
      const handler = createDigestQueueHandler(deps)
      let guard = 0
      while (pending.length > 0) {
        guard += 1
        if (guard > 20) {
          throw new Error('digest queue drain exceeded 20 batches')
        }
        const current = pending.splice(0)
        const retried: Pending[] = []
        const batch: MessageBatch<DigestQueueMessage> = {
          messages: current.map((item, index) => ({
            id: `digest_msg_${index}`,
            timestamp: new Date(),
            body: item.body,
            attempts: item.attempts,
            retry() {
              retried.push({ body: item.body, attempts: item.attempts + 1 })
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
