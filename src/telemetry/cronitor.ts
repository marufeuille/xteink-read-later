/**
 * Best-effort Cronitor Job telemetry.
 * Ping failures, timeouts, and missing secrets never fail the caller.
 * Access HTTP checks (docs/health-checks.md) do not use these bindings.
 */

export const CRONITOR_TELEMETRY_ORIGIN = 'https://cronitor.link'
export const CRONITOR_PING_TIMEOUT_MS = 2_000

export const CRONITOR_API_KEY_BINDING = 'CRONITOR_API_KEY'
export const CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING = 'CRONITOR_FEED_COLLECT_MONITOR_KEY'
export const CRONITOR_CLIP_MONITOR_KEY_BINDING = 'CRONITOR_CLIP_MONITOR_KEY'

export const CRONITOR_FEED_COLLECT_FAIL_MESSAGE = 'feed collection failed'
export const CRONITOR_CLIP_FAIL_MESSAGE = 'clip processing failed'

const METRIC_ORDER = ['count', 'duration', 'error_count'] as const
const MAX_MESSAGE_CHARS = 2_000

export type CronitorState = 'run' | 'complete' | 'fail'

export type CronitorJobMetrics = {
  readonly count?: number
  readonly duration?: number
  readonly error_count?: number
}

export type CronitorMonitorKeyBinding =
  | typeof CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING
  | typeof CRONITOR_CLIP_MONITOR_KEY_BINDING

export type CronitorEnv = {
  readonly [CRONITOR_API_KEY_BINDING]?: string
  readonly [CRONITOR_FEED_COLLECT_MONITOR_KEY_BINDING]?: string
  readonly [CRONITOR_CLIP_MONITOR_KEY_BINDING]?: string
}

export type TraceCronitorJobOptions<T> = {
  readonly env: CronitorEnv
  readonly monitorKeyBinding: CronitorMonitorKeyBinding
  readonly job: () => Promise<T>
  readonly metrics: (result: T) => CronitorJobMetrics
  readonly failed?: (result: T) => boolean
  readonly failMessage: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly series?: string
}

type PingOptions = {
  readonly apiKey: string
  readonly monitorKey: string
  readonly state: CronitorState
  readonly series: string
  readonly metrics?: CronitorJobMetrics
  readonly message?: string
  readonly fetch: typeof fetch
  readonly timeoutMs: number
}

function readBinding(env: object, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function formatMetricValue(name: (typeof METRIC_ORDER)[number], value: number): string | null {
  if (!Number.isFinite(value) || value < 0) {
    return null
  }
  if (name === 'duration') {
    return String(Math.round(value * 1000) / 1000)
  }
  return String(Math.trunc(value))
}

function appendMetrics(params: URLSearchParams, metrics: CronitorJobMetrics): void {
  for (const name of METRIC_ORDER) {
    const value = metrics[name]
    if (value === undefined) {
      continue
    }
    const formatted = formatMetricValue(name, value)
    if (formatted === null) {
      continue
    }
    params.append('metric', `${name}:${formatted}`)
  }
}

function elapsedSeconds(clock: () => number, started: number): number {
  const elapsed = clock() - started
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    return 0
  }
  return Math.round(elapsed) / 1000
}

function buildCronitorPingUrl(options: {
  readonly apiKey: string
  readonly monitorKey: string
  readonly state: CronitorState
  readonly series: string
  readonly metrics?: CronitorJobMetrics
  readonly message?: string
}): string | null {
  if (options.apiKey.length === 0 || options.monitorKey.length === 0 || options.series.length === 0) {
    return null
  }
  const url = new URL(
    `${CRONITOR_TELEMETRY_ORIGIN}/p/${encodeURIComponent(options.apiKey)}/${encodeURIComponent(options.monitorKey)}`,
  )
  if (url.origin !== CRONITOR_TELEMETRY_ORIGIN) {
    return null
  }
  url.searchParams.set('state', options.state)
  url.searchParams.set('series', options.series)
  if (options.metrics !== undefined) {
    appendMetrics(url.searchParams, options.metrics)
  }
  if (options.message !== undefined && options.message.length > 0) {
    url.searchParams.set('message', options.message.slice(0, MAX_MESSAGE_CHARS))
  }
  return url.toString()
}

async function sendCronitorPing(options: PingOptions): Promise<void> {
  try {
    const url = buildCronitorPingUrl(options)
    if (url === null) {
      return
    }
    const response = await options.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    await response.body?.cancel()
  } catch {
    return
  }
}

export async function traceCronitorJob<T>(options: TraceCronitorJobOptions<T>): Promise<T> {
  const apiKey = readBinding(options.env, CRONITOR_API_KEY_BINDING)
  const monitorKey = readBinding(options.env, options.monitorKeyBinding)
  if (apiKey === undefined || monitorKey === undefined) {
    return options.job()
  }

  const series = options.series ?? crypto.randomUUID()
  const clock = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? CRONITOR_PING_TIMEOUT_MS
  const fetchImpl = options.fetch ?? fetch
  const ping = (state: CronitorState, metrics?: CronitorJobMetrics, message?: string): Promise<void> =>
    sendCronitorPing({
      apiKey,
      monitorKey,
      state,
      series,
      fetch: fetchImpl,
      timeoutMs,
      ...(metrics === undefined ? {} : { metrics }),
      ...(message === undefined || message.length === 0 ? {} : { message }),
    })

  await ping('run')
  const started = clock()

  let result: T
  try {
    result = await options.job()
  } catch (error) {
    await ping('fail', { duration: elapsedSeconds(clock, started), error_count: 1 }, options.failMessage)
    throw error
  }

  try {
    const measured = {
      ...options.metrics(result),
      duration: elapsedSeconds(clock, started),
    }
    if (options.failed?.(result) ?? false) {
      await ping('fail', measured, options.failMessage)
    } else {
      await ping('complete', measured)
    }
  } catch {
    return result
  }
  return result
}
