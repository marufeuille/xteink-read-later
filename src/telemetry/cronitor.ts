import { logCronitor, type CronitorLog, type CronitorLogOutcome } from '../log'
import { cronitorConnect } from './cronitor-sockets'
import {
  CRONITOR_IPV4_HEADER,
  CRONITOR_IPV4_TRANSPORT,
  CRONITOR_TELEMETRY_HOSTS,
  CronitorLinkError,
  cronitorIpv4Fetch,
  isCronitorTimeout,
  type CronitorConnect,
} from './cronitor-ipv4'

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

const CRONITOR_REDIRECT_ORIGINS = new Set(CRONITOR_TELEMETRY_HOSTS.map((host) => `https://${host}`))
const MAX_CRONITOR_REDIRECTS = 2
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type BindingRead =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'missing' | 'blank' | 'not_string' }

function readBinding(env: object, name: string): BindingRead {
  const value = (env as Record<string, unknown>)[name]
  if (value === undefined) {
    return { ok: false, reason: 'missing' }
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: 'not_string' }
  }
  if (value.trim().length === 0) {
    return { ok: false, reason: 'blank' }
  }
  return { ok: true, value: value.trim() }
}

function bindingSkipOutcome(which: 'api' | 'monitor', reason: 'missing' | 'blank' | 'not_string'): CronitorLogOutcome {
  if (which === 'api') {
    if (reason === 'missing') {
      return 'missing_api_key'
    }
    if (reason === 'blank') {
      return 'blank_api_key'
    }
    return 'api_key_not_string'
  }
  if (reason === 'missing') {
    return 'missing_monitor_key'
  }
  if (reason === 'blank') {
    return 'blank_monitor_key'
  }
  return 'monitor_key_not_string'
}

function logCronitorSafe(entry: Parameters<typeof logCronitor>[0]): void {
  try {
    logCronitor(entry)
  } catch {
    // A log failure must not fail the clip or feed job.
  }
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

async function discardBody(response: Response): Promise<void> {
  try {
    // Read the body so the subrequest finishes. cancel() can reset the connection
    // before Cronitor commits the event: they respond 200 before authenticating.
    await response.arrayBuffer()
  } catch {
    // Do not log the error. The message can include the request URL.
  }
}

function allowedRedirect(current: string, response: Response): string | null {
  const location = response.headers.get('location')
  if (location === null || location.length === 0) {
    return null
  }
  let resolved: URL
  try {
    resolved = new URL(location, current)
  } catch {
    return null
  }
  if (resolved.protocol !== 'https:' || !CRONITOR_REDIRECT_ORIGINS.has(resolved.origin)) {
    return null
  }
  return resolved.toString()
}

async function sendCronitorPing(options: PingOptions): Promise<void> {
  let current: string
  try {
    const url = buildCronitorPingUrl(options)
    if (url === null) {
      logCronitorSafe({ outcome: 'invalid_ping', pingState: options.state })
      return
    }
    current = url
  } catch {
    logCronitorSafe({ outcome: 'invalid_ping', pingState: options.state })
    return
  }

  // One timeout covers DNS, the socket, and every allowed redirect.
  // The API key stays in the path, so only cronitor.link and eu.cronitor.link are followed.
  const signal = AbortSignal.timeout(options.timeoutMs)
  try {
    for (let hop = 0; hop <= MAX_CRONITOR_REDIRECTS; hop += 1) {
      const response = await options.fetch(current, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal,
      })
      const transport = transportFrom(response)
      if (REDIRECT_STATUSES.has(response.status)) {
        const next = allowedRedirect(current, response)
        await discardBody(response)
        if (next === null || hop === MAX_CRONITOR_REDIRECTS) {
          logCronitorSafe({
            outcome: 'redirect_blocked',
            pingState: options.state,
            httpStatus: response.status,
            ...transport,
          })
          return
        }
        current = next
        continue
      }
      await discardBody(response)
      if (response.status >= 200 && response.status < 300) {
        logCronitorSafe({ outcome: 'sent', pingState: options.state, ...transport })
        return
      }
      logCronitorSafe({
        outcome: 'http_error',
        pingState: options.state,
        httpStatus: response.status,
        ...transport,
      })
      return
    }
  } catch (error) {
    logCronitorSafe({
      pingState: options.state,
      ...failureFields(error),
    })
  }
}

function transportFrom(response: Response): { readonly transport: 'ipv4' } | Record<string, never> {
  return response.headers.get(CRONITOR_IPV4_HEADER) === CRONITOR_IPV4_TRANSPORT ? { transport: 'ipv4' } : {}
}

function failureFields(error: unknown): Pick<CronitorLog, 'outcome' | 'transport' | 'cause'> {
  const outcome = isCronitorTimeout(error) ? 'timeout' : 'network'
  if (error instanceof CronitorLinkError) {
    return { outcome, transport: 'ipv4', cause: error.code }
  }
  return { outcome }
}

function loadSocketConnect(): Promise<CronitorConnect | null> {
  return Promise.resolve(typeof cronitorConnect === 'function' ? cronitorConnect : null)
}

function socketsUnavailableFetch(): Promise<Response> {
  return Promise.reject(new CronitorLinkError('sockets'))
}

export async function selectCronitorFetch(
  injected: typeof fetch | undefined,
  load: () => Promise<CronitorConnect | null>,
): Promise<typeof fetch> {
  if (injected !== undefined) {
    return injected
  }
  try {
    const connect = await load()
    if (connect === null) {
      return socketsUnavailableFetch
    }
    return (input, init) => cronitorIpv4Fetch(input, init, { connect })
  } catch {
    return socketsUnavailableFetch
  }
}

export async function traceCronitorJob<T>(options: TraceCronitorJobOptions<T>): Promise<T> {
  const apiKey = readBinding(options.env, CRONITOR_API_KEY_BINDING)
  const monitorKey = readBinding(options.env, options.monitorKeyBinding)
  if (!apiKey.ok || !monitorKey.ok) {
    if (!apiKey.ok) {
      logCronitorSafe({ outcome: bindingSkipOutcome('api', apiKey.reason) })
    }
    if (!monitorKey.ok) {
      logCronitorSafe({ outcome: bindingSkipOutcome('monitor', monitorKey.reason) })
    }
    return options.job()
  }

  const series = options.series ?? crypto.randomUUID()
  const clock = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? CRONITOR_PING_TIMEOUT_MS
  const fetchImpl = await selectCronitorFetch(options.fetch, loadSocketConnect)
  const ping = (state: CronitorState, metrics?: CronitorJobMetrics, message?: string): Promise<void> =>
    sendCronitorPing({
      apiKey: apiKey.value,
      monitorKey: monitorKey.value,
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

  let measured: CronitorJobMetrics
  let terminalFail: boolean
  try {
    measured = {
      ...options.metrics(result),
      duration: elapsedSeconds(clock, started),
    }
    terminalFail = options.failed?.(result) ?? false
  } catch {
    logCronitorSafe({ outcome: 'metrics_failed' })
    return result
  }
  if (terminalFail) {
    await ping('fail', measured, options.failMessage)
  } else {
    await ping('complete', measured)
  }
  return result
}
