export type RecordedCronitorPing = {
  readonly href: string
  readonly method: string
  readonly redirect: string
  readonly cache: string
  readonly state: string
  readonly series: string
  readonly message: string | null
  readonly metrics: ReadonlyMap<string, string>
}

export function readCronitorPing(input: RequestInfo | URL, init?: RequestInit): RecordedCronitorPing {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href)
  const metrics = new Map<string, string>()
  for (const value of url.searchParams.getAll('metric')) {
    const index = value.indexOf(':')
    if (index <= 0) {
      continue
    }
    metrics.set(value.slice(0, index), value.slice(index + 1))
  }
  return {
    href,
    method: init?.method ?? 'GET',
    redirect: init?.redirect ?? '',
    state: url.searchParams.get('state') ?? '',
    series: url.searchParams.get('series') ?? '',
    message: url.searchParams.get('message'),
    metrics,
    cache: init?.cache ?? '',
  }
}

export function createCronitorFetch(
  respond: () => Response | Promise<Response> = () => new Response('ok'),
): {
  readonly fetch: typeof fetch
  readonly pings: RecordedCronitorPing[]
} {
  const pings: RecordedCronitorPing[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    pings.push(readCronitorPing(input, init))
    return respond()
  }
  return { fetch: fetchImpl, pings }
}

export function createThrowingCronitorFetch(error: Error = new Error('cronitor down')): {
  readonly fetch: typeof fetch
  readonly calls: number
} {
  let calls = 0
  const fetchImpl: typeof fetch = async () => {
    calls += 1
    throw error
  }
  return {
    fetch: fetchImpl,
    get calls() {
      return calls
    },
  }
}

export function createHangingCronitorFetch(): typeof fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) {
        return
      }
      const abort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
    })
}
