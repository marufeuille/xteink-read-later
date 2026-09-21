import { createApp } from './app'
import { clipPipeline } from './pipeline/clip'
import { createClipQueueHandler } from './queue/clip'
import { createFeedQueueHandler, FEED_QUEUE_NAME } from './queue/feed'
import { createD1CandidateStore } from './store/d1-candidates'
import { createR2Store } from './store/r2'
import type { ClipQueueMessage, FeedQueueMessage } from './types'

const app = createApp({ createStore: createR2Store })

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    if (batch.queue === FEED_QUEUE_NAME) {
      await createFeedQueueHandler()(batch as MessageBatch<FeedQueueMessage>, env)
      return
    }
    await createClipQueueHandler({
      clipPipeline,
      createStore: createR2Store,
      createCandidateStore: createD1CandidateStore,
    })(batch as MessageBatch<ClipQueueMessage>, env)
  },
} satisfies ExportedHandler<Cloudflare.Env, ClipQueueMessage | FeedQueueMessage>
