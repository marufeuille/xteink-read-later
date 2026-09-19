import { createApp } from './app'
import { clipPipeline } from './pipeline/clip'
import { createR2Store } from './store/r2'

export default createApp({
  clipPipeline,
  createStore: createR2Store,
})
