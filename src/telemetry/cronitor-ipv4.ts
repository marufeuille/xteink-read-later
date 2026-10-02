/**
 * Cronitor telemetry over a public IPv4 TLS socket.
 * Workers fetch() cannot pin an A record and leaves from Cloudflare anycast.
 * Production clip pings then fail before a response (outcome=network).
 * TCP sockets use a different egress prefix and can dial an IPv4 literal.
 * The API key stays on cronitor.link / eu.cronitor.link only.
 */

export const CRONITOR_TELEMETRY_HOSTS = ['cronitor.link', 'eu.cronitor.link'] as const
export const CRONITOR_IPV4_HEADER = 'x-xteink-telemetry-transport'
export const CRONITOR_IPV4_TRANSPORT = 'ipv4' as const

const ALLOWED_HOSTS = new Set<string>(CRONITOR_TELEMETRY_HOSTS)
const DOH_URL = 'https://cloudflare-dns.com/dns-query'
const MAX_HEADER_BYTES = 8_192
const MAX_HTTP_BYTES = 65_536
const MAX_DNS_TTL_MS = 60_000

export type CronitorLinkCause = 'dns' | 'connect' | 'http'

export class CronitorLinkError extends Error {
  readonly code: CronitorLinkCause

  constructor(code: CronitorLinkCause, cause?: unknown) {
    super(code)
    this.code = code
    this.name = isCronitorTimeout(cause) ? 'TimeoutError' : 'CronitorLinkError'
  }
}

export function isCronitorTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

type TlsSocket = {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  readonly opened: Promise<unknown>
  close(): Promise<void> | void
}

export type CronitorSocket = TlsSocket & {
  startTls(options?: { readonly expectedServerHostname?: string }): TlsSocket
}

export type CronitorConnect = (
  address: { readonly hostname: string; readonly port: number },
  options: { readonly secureTransport: 'starttls'; readonly allowHalfOpen: false },
) => CronitorSocket

type DnsCacheEntry = {
  readonly ips: readonly string[]
  readonly expires: number
}

const dnsCache = new Map<string, DnsCacheEntry>()

export function resetCronitorDnsCache(): void {
  dnsCache.clear()
}

export function isPublicIpv4(value: string): boolean {
  const parsed = ipv4Octets(value)
  if (parsed === null) {
    return false
  }
  const [first, second, third] = parsed
  if (first === 0 || first === 10 || first === 127 || first >= 224) {
    return false
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return false
  }
  if (first === 169 && second === 254) {
    return false
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return false
  }
  if (first === 192 && second === 168) {
    return false
  }
  if (first === 192 && second === 0 && third === 2) {
    return false
  }
  if (first === 198 && second >= 18 && second <= 19) {
    return false
  }
  if (first === 198 && second === 51 && third === 100) {
    return false
  }
  if (first === 203 && second === 0 && third === 113) {
    return false
  }
  return true
}

export async function lookupPublicIpv4(
  host: string,
  dohFetch: typeof fetch,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (!ALLOWED_HOSTS.has(host)) {
    throw new CronitorLinkError('dns')
  }
  const cached = dnsCache.get(host)
  if (cached !== undefined && cached.expires > Date.now()) {
    return cached.ips
  }
  const endpoint = new URL(DOH_URL)
  endpoint.searchParams.set('name', host)
  endpoint.searchParams.set('type', 'A')
  let response: Response
  try {
    response = await raceSignal(
      dohFetch(endpoint, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/dns-json' },
        signal,
      }),
      signal,
    )
  } catch (error) {
    throw linkError('dns', error)
  }
  if (!response.ok) {
    await drain(response)
    throw new CronitorLinkError('dns')
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw linkError('dns', error)
  }
  const found = publicAnswers(payload)
  if (found.ips.length === 0) {
    throw new CronitorLinkError('dns')
  }
  if (found.ttlMs > 0) {
    dnsCache.set(host, { ips: found.ips, expires: Date.now() + found.ttlMs })
  } else {
    dnsCache.delete(host)
  }
  return found.ips
}

export async function cronitorIpv4Fetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deps: {
    readonly connect: CronitorConnect
    readonly lookup?: (host: string, signal: AbortSignal) => Promise<readonly string[]>
  },
): Promise<Response> {
  const signal = init?.signal
  if (signal === undefined || signal === null) {
    throw new CronitorLinkError('connect')
  }
  const url = pingUrl(input)
  const lookup = deps.lookup ?? ((host, inner) => lookupPublicIpv4(host, fetch, inner))
  const ips = (await lookup(url.hostname, signal)).filter((ip) => isPublicIpv4(ip))
  const tls = await dial(url.hostname, ips, signal, deps.connect)
  try {
    const writer = tls.writable.getWriter()
    try {
      await raceSignal(writer.write(requestBytes(url)), signal)
      await raceSignal(writer.close(), signal)
    } catch (error) {
      throw linkError('connect', error)
    }
    const reader = tls.readable.getReader()
    try {
      const message = await readHttp(reader, signal)
      const headers = new Headers(message.headers)
      headers.delete('connection')
      headers.delete('keep-alive')
      headers.delete('transfer-encoding')
      headers.delete('content-length')
      headers.set(CRONITOR_IPV4_HEADER, CRONITOR_IPV4_TRANSPORT)
      return new Response(message.body, { status: message.status, headers })
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  } finally {
    await closeQuiet(tls)
  }
}

function pingUrl(input: RequestInfo | URL): URL {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let url: URL
  try {
    url = new URL(href)
  } catch (error) {
    throw linkError('http', error)
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new CronitorLinkError('connect')
  }
  return url
}

async function dial(
  host: string,
  ips: readonly string[],
  signal: AbortSignal,
  connect: CronitorConnect,
): Promise<TlsSocket> {
  if (ips.length === 0) {
    throw new CronitorLinkError('dns')
  }
  let last: unknown
  for (const ip of ips) {
    try {
      return await openTls(ip, host, signal, connect)
    } catch (error) {
      if (isCronitorTimeout(error)) {
        throw linkError('connect', error)
      }
      last = error
    }
  }
  try {
    return await openTls(host, host, signal, connect)
  } catch (error) {
    if (isCronitorTimeout(error)) {
      throw linkError('connect', error)
    }
    throw linkError('connect', last ?? error)
  }
}

async function openTls(
  dialHost: string,
  sni: string,
  signal: AbortSignal,
  connect: CronitorConnect,
): Promise<TlsSocket> {
  let socket: CronitorSocket
  try {
    socket = connect(
      { hostname: dialHost, port: 443 },
      { secureTransport: 'starttls', allowHalfOpen: false },
    )
  } catch (error) {
    throw linkError('connect', error)
  }
  try {
    await raceSignal(socket.opened, signal)
    const tls = socket.startTls({ expectedServerHostname: sni })
    await raceSignal(tls.opened, signal)
    return tls
  } catch (error) {
    await closeQuiet(socket)
    throw linkError('connect', error)
  }
}

function requestBytes(url: URL): Uint8Array {
  const path = `${url.pathname}${url.search}`
  if (!path.startsWith('/') || /[\r\n\0]/.test(path) || /[\r\n\0]/.test(url.hostname)) {
    throw new CronitorLinkError('http')
  }
  return new TextEncoder().encode(
    `GET ${path} HTTP/1.1\r\nHost: ${url.hostname}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
  )
}

type HttpMessage = {
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
}

async function readHttp(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<HttpMessage> {
  const chunks: Uint8Array[] = []
  let size = 0
  const pull = async (): Promise<boolean> => {
    const next = await raceSignal(reader.read(), signal)
    if (next.done) {
      return false
    }
    size += next.value.byteLength
    if (size > MAX_HTTP_BYTES) {
      throw new CronitorLinkError('http')
    }
    chunks.push(next.value)
    return true
  }
  while (true) {
    const inspected = inspectHttp(concat(chunks, size), false)
    if (typeof inspected !== 'string') {
      return inspected
    }
    if (inspected === 'invalid') {
      throw new CronitorLinkError('http')
    }
    const more = await pull()
    if (more) {
      continue
    }
    const finished = inspectHttp(concat(chunks, size), true)
    if (typeof finished === 'string') {
      throw new CronitorLinkError('http')
    }
    return finished
  }
}

function inspectHttp(bytes: Uint8Array, eof: boolean): HttpMessage | 'need-more' | 'need-close' | 'invalid' {
  const headerEnd = findHeaderEnd(bytes)
  if (headerEnd === null) {
    if (bytes.length > MAX_HEADER_BYTES) {
      return 'invalid'
    }
    return eof ? 'invalid' : 'need-more'
  }
  if (headerEnd > MAX_HEADER_BYTES) {
    return 'invalid'
  }
  const parsed = parseHead(new TextDecoder().decode(bytes.subarray(0, headerEnd)))
  if (parsed === null) {
    return 'invalid'
  }
  const bodyStart = headerEnd + 4
  if (parsed.contentLength !== null) {
    const total = bodyStart + parsed.contentLength
    if (bytes.length < total) {
      return eof ? 'invalid' : 'need-more'
    }
    return { status: parsed.status, headers: parsed.headers, body: bytes.slice(bodyStart, total) }
  }
  if (!eof) {
    return 'need-close'
  }
  return { status: parsed.status, headers: parsed.headers, body: bytes.slice(bodyStart) }
}

function parseHead(head: string): { status: number; headers: Headers; contentLength: number | null } | null {
  const lines = head.split('\r\n')
  const first = lines[0]
  if (first === undefined) {
    return null
  }
  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(first)
  const statusText = match?.[1]
  if (statusText === undefined) {
    return null
  }
  const status = Number(statusText)
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return null
  }
  const headers = new Headers()
  const lengths: number[] = []
  let chunked = false
  for (const line of lines.slice(1)) {
    const sep = line.indexOf(':')
    if (sep <= 0) {
      return null
    }
    const name = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (name.toLowerCase() === 'content-length') {
      if (!/^\d+$/.test(value)) {
        return null
      }
      const length = Number(value)
      if (!Number.isSafeInteger(length)) {
        return null
      }
      lengths.push(length)
    }
    if (name.toLowerCase() === 'transfer-encoding' && value.toLowerCase().includes('chunked')) {
      chunked = true
    }
    headers.append(name, value)
  }
  if (lengths.some((length) => length !== lengths[0])) {
    return null
  }
  const contentLength = lengths[0]
  if (chunked && contentLength === undefined) {
    return null
  }
  if (contentLength !== undefined && contentLength > MAX_HTTP_BYTES) {
    return null
  }
  return { status, headers, contentLength: contentLength ?? null }
}

function publicAnswers(payload: unknown): { ips: readonly string[]; ttlMs: number } {
  if (typeof payload !== 'object' || payload === null) {
    return { ips: [], ttlMs: 0 }
  }
  const answer = (payload as { Answer?: unknown }).Answer
  if (!Array.isArray(answer)) {
    return { ips: [], ttlMs: 0 }
  }
  const ips: string[] = []
  let ttlSeconds = 60
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as { type?: unknown; data?: unknown; TTL?: unknown }
    if (record.type !== 1 || typeof record.data !== 'string' || !isPublicIpv4(record.data)) {
      continue
    }
    if (!ips.includes(record.data)) {
      ips.push(record.data)
    }
    if (typeof record.TTL === 'number' && Number.isFinite(record.TTL)) {
      ttlSeconds = Math.min(ttlSeconds, Math.max(0, Math.trunc(record.TTL)))
    }
  }
  return { ips, ttlMs: Math.min(MAX_DNS_TTL_MS, ttlSeconds * 1000) }
}

function ipv4Octets(value: string): readonly [number, number, number, number] | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    return null
  }
  const numbers = value.split('.').map((part) => Number(part))
  if (numbers.some((part) => !Number.isInteger(part) || part > 255)) {
    return null
  }
  const first = numbers[0]
  const second = numbers[1]
  const third = numbers[2]
  const fourth = numbers[3]
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return null
  }
  return [first, second, third, fourth]
}

function findHeaderEnd(bytes: Uint8Array): number | null {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index
    }
  }
  return null
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal))
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortError(signal: AbortSignal): CronitorLinkError {
  return new CronitorLinkError('connect', signal.reason)
}

function linkError(code: CronitorLinkCause, error: unknown): CronitorLinkError {
  if (error instanceof CronitorLinkError) {
    return error
  }
  return new CronitorLinkError(code, error)
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer()
  } catch {
    // The body can include the request URL. Do not log it.
  }
}

async function closeQuiet(socket: { close(): Promise<void> | void }): Promise<void> {
  try {
    await socket.close()
  } catch {
    // Closing a failed dial must not replace the original error.
  }
}
