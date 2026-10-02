import { createMemoryDigestRunStore } from './run-store'
import { processDigestDelivery, type DigestEnqueue } from './deliver'
import type { RunDailyDigestDeps } from './deps'
import { dailyDateFromInstant } from './identity'
import type { DigestQueueMessage, DigestRunResult } from '../types'

export type { RunDailyDigestDeps } from './deps'

const MAX_STEPS = 1000

export async function runDailyDigest(env: Cloudflare.Env, deps: RunDailyDigestDeps): Promise<DigestRunResult> {
  const now = deps.now ?? (() => new Date())
  const date = deps.date ?? dailyDateFromInstant(now())
  const runStore = deps.runStore ?? createMemoryDigestRunStore()
  const stepDeps: RunDailyDigestDeps = { ...deps, date, runStore, now }
  const pending: { body: DigestQueueMessage; attempts: number }[] = [{ body: { date }, attempts: 1 }]
  let finished: DigestRunResult | null = null
  let guard = 0

  while (pending.length > 0) {
    guard += 1
    if (guard > MAX_STEPS) {
      throw new Error('digest run exceeded step budget')
    }
    const current = pending.shift()
    if (current === undefined) {
      break
    }
    const outcome = await processDigestDelivery(env, stepDeps, current.body, current.attempts, {
      scheduleWatchdog: false,
    })
    if (outcome.finished !== null) {
      finished = outcome.finished
    }
    if (outcome.action === 'retry') {
      pending.push({ body: current.body, attempts: current.attempts + 1 })
      continue
    }
    for (const item of outcome.enqueue) {
      pending.push(queued(item))
    }
  }

  if (finished !== null) {
    return finished
  }
  return { date, status: 'failed', selected: 0, summarized: 0, skipped: 0, articleId: null, qrCount: 0 }
}

function queued(item: DigestEnqueue): { body: DigestQueueMessage; attempts: number } {
  return { body: item.body, attempts: 1 }
}
