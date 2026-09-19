import { createApp } from './app'
import { clipPipeline } from './pipeline/clip'
import { createClipQueueHandler } from './queue/clip'
import { createR2Store } from './store/r2'
import type { ClipQueueMessage } from './types'

const app = createApp({ createStore: createR2Store })

export default {
  fetch: app.fetch,
  queue: createClipQueueHandler({
    clipPipeline,
    createStore: createR2Store,
  }),
} satisfies ExportedHandler<Cloudflare.Env, ClipQueueMessage>
