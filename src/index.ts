import { Hono } from 'hono'
import type { AppEnv } from './types'

const app = new Hono<AppEnv>()

export default app
