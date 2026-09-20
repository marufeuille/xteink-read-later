import { createClipQueueHandler, type ClipQueueHandlerDeps } from '../src/queue/clip'
import type { ClipQueueMessage } from '../src/types'

const EMPTY_METRICS = { backlogCount: 0, backlogBytes: 0 }

type Pending = {
  body: ClipQueueMessage
  attempts: number
}

export type FakeQueue = Queue<ClipQueueMessage> & {
  readonly size: number
  peek(): readonly ClipQueueMessage[]
  push(body: ClipQueueMessage, attempts?: number): void
  drain(env: Cloudflare.Env, deps?: ClipQueueHandlerDeps): Promise<void>
}

export function createFakeQueue(
  options: { onSend?: (message: ClipQueueMessage) => void | Promise<void> } = {},
): FakeQueue {
  const pending: Pending[] = []
  const sendResponse = {
    metadata: { metrics: { ...EMPTY_METRICS } },
  }

  const queue: FakeQueue = {
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
      const handler = createClipQueueHandler(deps)
      let guard = 0
      while (pending.length > 0) {
        guard += 1
        if (guard > 20) {
          throw new Error('clip queue drain exceeded 20 batches')
        }
        const current = pending.splice(0)
        const retried: Pending[] = []
        const batch: MessageBatch<ClipQueueMessage> = {
          messages: current.map((item, index) => ({
            id: `msg_${index}`,
            timestamp: new Date(),
            body: item.body,
            attempts: item.attempts,
            retry() {
              retried.push({ body: item.body, attempts: item.attempts + 1 })
            },
            ack() {},
          })),
          queue: 'xteink-read-later-clip',
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
