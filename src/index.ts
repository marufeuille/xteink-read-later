import { createApp } from './app'
import { clipPipeline } from './pipeline/clip'
import { createMemoryStore } from './store/memory'

export default createApp({
  clipPipeline,
  store: createMemoryStore(),
})
