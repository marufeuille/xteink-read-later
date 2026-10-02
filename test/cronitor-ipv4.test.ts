import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CRONITOR_API_KEY_BINDING,
  CRONITOR_CLIP_FAIL_MESSAGE,
  CRONITOR_CLIP_MONITOR_KEY_BINDING,
  selectCronitorFetch,
  traceCronitorJob,
} from '../src/telemetry/cronitor'
import {
  CRONITOR_IPV4_HEADER,
  CronitorLinkError,
  cronitorIpv4Fetch,
  isPublicIpv4,
  lookupPublicIpv4,
  resetCronitorDnsCache,
} from '../src/telemetry/cronitor-ipv4'
import { TEST_BINDINGS } from './bindings'
import { createCronitorFetch } from './cronitor-fetch'
import { bytesThenEof, createScriptedCronitorConnect, httpResponse } from './cronitor-ipv4-harness'

const API_KEY = 'cronitor-test-api'
const CLIP_MONITOR = 'xteink-clip'
const IPV4 = '44.230.87.160'
const EU_IPV4 = '18.197.117.191'
const SECRET = 'telemetry-secret-must-not-leak'

afterEach(() => {
  resetCronitorDnsCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function clipEnv(): Cloudflare.Env {
  return {
    ...TEST_BINDINGS,
    [CRONITOR_API_KEY_BINDING]: API_KEY,
    [CRONITOR_CLIP_MONITOR_KEY_BINDING]: CLIP_MONITOR,
  } as Cloudflare.Env
}

function emptyOk(): Uint8Array {
  return httpResponse(200, { 'Content-Type': 'application/json', 'Content-Length': '0' })
}

function ipv4Fetch(
  connect: ReturnType<typeof createScriptedCronitorConnect>['connect'],
  lookup: (host: string) => readonly string[] = () => [IPV4],
): typeof fetch {
  return (input, init) =>
    cronitorIpv4Fetch(input, init, {
      connect,
      lookup: (host) => Promise.resolve(lookup(host)),
    })
}

function cronitorLogs(): Record<string, unknown>[] {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call[0])
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && (value as { event?: unknown }).event === 'cronitor',
    )
}

describe('Cronitor IPv4 transport', () => {
  it('links cloudflare:sockets with a static import the bundler can see', () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const sockets = readFileSync(join(root, '..', 'src', 'telemetry', 'cronitor-sockets.ts'), 'utf8')
    const caller = readFileSync(join(root, '..', 'src', 'telemetry', 'cronitor.ts'), 'utf8')
    expect(sockets).toContain("from 'cloudflare:sockets'")
    expect(caller).toContain("from './cronitor-sockets'")
    expect(caller).not.toContain("import('./cronitor-sockets')")
    expect(caller).not.toContain('return fetch')
  })

  it('accepts public IPv4 and rejects private, documentation, and malformed addresses', () => {
    expect(isPublicIpv4(IPV4)).toBe(true)
    expect(isPublicIpv4(EU_IPV4)).toBe(true)
    expect(isPublicIpv4('1.2.3.4')).toBe(true)
    for (const blocked of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '100.64.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.168.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255',
      '01.2.3.4',
      '1.2.3',
      '1.2.3.4.5',
      'cronitor.link',
    ]) {
      expect(isPublicIpv4(blocked)).toBe(false)
    }
  })

  it('reads public A records from DNS-over-HTTPS and caches them', async () => {
    let calls = 0
    const doh: typeof fetch = async (input) => {
      calls += 1
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      expect(url.origin).toBe('https://cloudflare-dns.com')
      expect(url.searchParams.get('name')).toBe('cronitor.link')
      expect(url.searchParams.get('type')).toBe('A')
      expect(url.href).not.toContain(API_KEY)
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: [
            { type: 1, TTL: 60, data: '10.1.2.3' },
            { type: 1, TTL: 30, data: IPV4 },
            { type: 5, TTL: 60, data: 'cronitor.link' },
            { type: 1, TTL: 30, data: IPV4 },
            { type: 1, TTL: 30, data: '54.68.179.145' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/dns-json' } },
      )
    }
    const signal = AbortSignal.timeout(1_000)
    await expect(lookupPublicIpv4('cronitor.link', doh, signal)).resolves.toEqual([IPV4, '54.68.179.145'])
    await expect(lookupPublicIpv4('cronitor.link', doh, signal)).resolves.toEqual([IPV4, '54.68.179.145'])
    expect(calls).toBe(1)
    await expect(lookupPublicIpv4('evil.example', doh, signal)).rejects.toMatchObject({ code: 'dns' })
    expect(calls).toBe(1)
  })

  it('does not cache a zero TTL answer', async () => {
    let calls = 0
    const doh: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ Answer: [{ type: 1, TTL: 0, data: IPV4 }] }), { status: 200 })
    }
    const signal = AbortSignal.timeout(1_000)
    await lookupPublicIpv4('eu.cronitor.link', doh, signal)
    await lookupPublicIpv4('eu.cronitor.link', doh, signal)
    expect(calls).toBe(2)
  })

  it('dials the public IPv4 with the telemetry hostname as SNI and Host', async () => {
    const scripted = createScriptedCronitorConnect(() => emptyOk())
    const response = await cronitorIpv4Fetch(
      'https://cronitor.link/p/cronitor-test-api/xteink-clip?state=run&series=series-fixed',
      { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(1_000) },
      { connect: scripted.connect, lookup: async () => [IPV4, '10.0.0.1'] },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get(CRONITOR_IPV4_HEADER)).toBe('ipv4')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array())
    expect(scripted.dials).toHaveLength(1)
    expect(scripted.dials[0]).toMatchObject({ hostname: IPV4, port: 443, sni: 'cronitor.link' })
    expect(scripted.dials[0]?.request).toContain(
      'GET /p/cronitor-test-api/xteink-clip?state=run&series=series-fixed HTTP/1.1\r\n',
    )
    expect(scripted.dials[0]?.request).toContain('Host: cronitor.link\r\n')
    expect(scripted.dials[0]?.request).not.toContain(IPV4)
  })

  it('returns a zero-length 200 without waiting for the socket to close', async () => {
    const scripted = createScriptedCronitorConnect(() => emptyOk())
    const pending = cronitorIpv4Fetch('https://cronitor.link/p/k/m?state=run', {
      signal: AbortSignal.timeout(1_000),
    }, { connect: scripted.connect, lookup: async () => [IPV4] })
    await expect(pending).resolves.toMatchObject({ status: 200 })
  })

  it('treats a chunked 200 without content-length as sent', async () => {
    const chunked = httpResponse(
      200,
      { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked', Connection: 'close' },
      '2\r\nOK\r\n0\r\n\r\n',
    )
    const scripted = createScriptedCronitorConnect(() => chunked)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const response = await cronitorIpv4Fetch('https://cronitor.link/p/k/m?state=run', {
      signal: AbortSignal.timeout(1_000),
    }, { connect: scripted.connect, lookup: async () => [IPV4] })
    expect(response.status).toBe(200)
    expect(response.headers.get(CRONITOR_IPV4_HEADER)).toBe('ipv4')
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('OK')

    const kept = await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(scripted.connect),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    expect(kept).toBe('kept')
    const logs = cronitorLogs()
    expect(logs.map((entry) => entry.message)).toEqual(['cronitor sent run', 'cronitor sent complete'])
    expect(logs[0]).toMatchObject({ outcome: 'sent', pingState: 'run', transport: 'ipv4' })
    expect(logs[1]).toMatchObject({ outcome: 'sent', pingState: 'complete', transport: 'ipv4' })
    expect(JSON.stringify(logs)).not.toContain(API_KEY)
    expect(JSON.stringify(logs)).not.toContain('OK')
  })

  it('keeps sent when a chunked 200 ends before the chunk framing is complete', async () => {
    const partial = bytesThenEof(
      httpResponse(200, { 'Transfer-Encoding': 'chunked' }, '5\r\nhel'),
    )
    const scripted = createScriptedCronitorConnect(() => partial)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(scripted.connect),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    const logs = cronitorLogs()
    expect(logs.map((entry) => entry.outcome)).toEqual(['sent', 'sent'])
    expect(logs[0]).toMatchObject({ transport: 'ipv4', pingState: 'run' })
    expect(JSON.stringify(logs)).not.toContain('hel')
    expect(JSON.stringify(logs)).not.toContain(API_KEY)
  })

  it('classifies a dropped response as connect and a broken status line as http', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dropped = createScriptedCronitorConnect(() => 'eof')
    await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(dropped.connect),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    const droppedLogs = cronitorLogs()
    expect(droppedLogs.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(droppedLogs[0]).toMatchObject({ outcome: 'network', pingState: 'run', transport: 'ipv4', cause: 'connect' })
    expect(droppedLogs[1]).toMatchObject({ outcome: 'network', pingState: 'complete', transport: 'ipv4', cause: 'connect' })
    expect(dropped.dials.map((dial) => dial.hostname)).toEqual([IPV4, 'cronitor.link', IPV4, 'cronitor.link'])

    const broken = createScriptedCronitorConnect(() => new TextEncoder().encode('HTTP/2 200\r\nContent-Length: 0\r\n\r\n'))
    await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(broken.connect),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    const brokenLogs = cronitorLogs().slice(droppedLogs.length)
    expect(brokenLogs.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(brokenLogs[0]).toMatchObject({ outcome: 'network', pingState: 'run', transport: 'ipv4', cause: 'http' })
    expect(brokenLogs[1]).toMatchObject({ outcome: 'network', pingState: 'complete', transport: 'ipv4', cause: 'http' })
    const text = JSON.stringify([...droppedLogs, ...brokenLogs])
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain(IPV4)
    expect(text).not.toContain('HTTP/2')
  })

  it('keeps transport and cause when every socket read fails, and still returns the job', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const scripted = createScriptedCronitorConnect(() => 'read-error')
    const kept = await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(scripted.connect, () => [IPV4]),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    expect(kept).toBe('kept')
    expect(scripted.dials.map((dial) => dial.hostname)).toEqual([
      IPV4,
      'cronitor.link',
      IPV4,
      'cronitor.link',
    ])
    const logs = cronitorLogs()
    expect(logs.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(logs[0]).toMatchObject({ outcome: 'network', pingState: 'run', transport: 'ipv4', cause: 'connect' })
    expect(logs[1]).toMatchObject({
      outcome: 'network',
      pingState: 'complete',
      transport: 'ipv4',
      cause: 'connect',
    })
    const text = JSON.stringify(logs)
    expect(text).not.toContain('read-failed-token')
    expect(text).not.toContain('TypeError')
    expect(text).not.toContain(IPV4)
    expect(text).not.toContain(API_KEY)
  })

  it('retries the hostname when an IPv4 socket opens and then the read fails', async () => {
    const scripted = createScriptedCronitorConnect(({ hostname }) =>
      hostname === 'cronitor.link' ? emptyOk() : 'read-error',
    )
    const response = await cronitorIpv4Fetch(
      'https://cronitor.link/p/k/m?state=run',
      { signal: AbortSignal.timeout(1_000) },
      { connect: scripted.connect, lookup: async () => [IPV4] },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get(CRONITOR_IPV4_HEADER)).toBe('ipv4')
    expect(scripted.dials.map((dial) => dial.hostname)).toEqual([IPV4, 'cronitor.link'])
    expect(scripted.dials[0]?.sni).toBe('cronitor.link')
    expect(scripted.dials[1]?.sni).toBe('cronitor.link')
  })

  it('tries the next A record, then the hostname, when an address dial fails', async () => {
    const scripted = createScriptedCronitorConnect(({ hostname }) => {
      if (hostname === '1.2.3.4') {
        return new Error('dial-failure-token')
      }
      return emptyOk()
    })
    const first = await cronitorIpv4Fetch('https://cronitor.link/p/k/m?state=complete', {
      signal: AbortSignal.timeout(1_000),
    }, { connect: scripted.connect, lookup: async () => ['1.2.3.4', IPV4] })
    expect(first.status).toBe(200)
    expect(scripted.dials.map((dial) => dial.hostname)).toEqual(['1.2.3.4', IPV4])

    const fallback = createScriptedCronitorConnect(({ hostname }) =>
      hostname === 'eu.cronitor.link' ? emptyOk() : new Error('ip-literal-rejected'),
    )
    const second = await cronitorIpv4Fetch('https://eu.cronitor.link/p/k/m?state=run', {
      signal: AbortSignal.timeout(1_000),
    }, { connect: fallback.connect, lookup: async () => ['1.2.3.4'] })
    expect(second.status).toBe(200)
    expect(fallback.dials.map((dial) => dial.hostname)).toEqual(['1.2.3.4', 'eu.cronitor.link'])
    expect(fallback.dials[1]?.sni).toBe('eu.cronitor.link')
  })

  it('does not dial private answers or other hosts', async () => {
    const scripted = createScriptedCronitorConnect(() => emptyOk())
    await expect(
      cronitorIpv4Fetch('https://cronitor.link/p/k/m', {
        signal: AbortSignal.timeout(1_000),
      }, { connect: scripted.connect, lookup: async () => ['10.1.2.3', '192.168.1.1'] }),
    ).rejects.toMatchObject({ code: 'dns' })
    await expect(
      cronitorIpv4Fetch('https://example.com/p/k/m', {
        signal: AbortSignal.timeout(1_000),
      }, { connect: scripted.connect, lookup: async () => [IPV4] }),
    ).rejects.toMatchObject({ code: 'connect' })
    expect(scripted.dials).toEqual([])
  })

  it('reports sent with transport ipv4 and still returns the job when the dial fails', async () => {
    const scripted = createScriptedCronitorConnect(() => emptyOk())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const sent = await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(scripted.connect),
      series: 'series-fixed',
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    expect(sent).toBe('kept')
    expect(scripted.dials).toHaveLength(2)
    expect(scripted.dials[0]?.sni).toBe('cronitor.link')
    expect(scripted.dials[0]?.request).toContain(`/p/${API_KEY}/${CLIP_MONITOR}`)
    const sentLogs = cronitorLogs()
    expect(sentLogs.map((entry) => entry.message)).toEqual(['cronitor sent run', 'cronitor sent complete'])
    expect(sentLogs[0]).toMatchObject({ outcome: 'sent', pingState: 'run', transport: 'ipv4' })
    expect(sentLogs[1]).toMatchObject({ outcome: 'sent', pingState: 'complete', transport: 'ipv4' })
    expect(JSON.stringify(sentLogs)).not.toContain(API_KEY)
    expect(JSON.stringify(sentLogs)).not.toContain(IPV4)

    const failing = createScriptedCronitorConnect(() => new Error(`${SECRET} dial-failure-token ${IPV4}`))
    const kept = await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(failing.connect, () => ['1.2.3.4']),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    expect(kept).toBe('kept')
    const failedLogs = cronitorLogs().slice(sentLogs.length)
    expect(failedLogs.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(failedLogs[0]).toMatchObject({ outcome: 'network', pingState: 'run', transport: 'ipv4', cause: 'connect' })
    expect(failedLogs[1]).toMatchObject({
      outcome: 'network',
      pingState: 'complete',
      transport: 'ipv4',
      cause: 'connect',
    })
    const text = JSON.stringify(failedLogs)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain('1.2.3.4')
    expect(text).not.toContain('dial-failure-token')
    expect(text).not.toContain(IPV4)
  })

  it('classifies a hung socket as timeout and does not follow an off-host redirect', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const hung = createScriptedCronitorConnect(() => 'hang')
    const started = Date.now()
    await expect(
      traceCronitorJob({
        env: clipEnv(),
        monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
        failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
        fetch: ipv4Fetch(hung.connect),
        timeoutMs: 30,
        job: async () => 'kept',
        metrics: () => ({ count: 0, error_count: 0 }),
      }),
    ).resolves.toBe('kept')
    expect(Date.now() - started).toBeLessThan(1_000)
    const timeoutLogs = cronitorLogs()
    expect(timeoutLogs.map((entry) => entry.message)).toEqual(['cronitor timeout run', 'cronitor timeout complete'])
    expect(timeoutLogs[0]).toMatchObject({ outcome: 'timeout', transport: 'ipv4', cause: 'connect' })
    expect(JSON.stringify(timeoutLogs)).not.toContain('TimeoutError')

    const redirected = createScriptedCronitorConnect(() =>
      httpResponse(302, { Location: 'https://example.com/p/stolen', 'Content-Length': '0' }),
    )
    await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(redirected.connect),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    expect(redirected.dials.map((dial) => dial.hostname)).toEqual([IPV4, IPV4])
    expect(redirected.dials.every((dial) => !dial.request.includes('example.com'))).toBe(true)
    const redirectLogs = cronitorLogs().slice(timeoutLogs.length)
    expect(redirectLogs.map((entry) => entry.outcome)).toEqual(['redirect_blocked', 'redirect_blocked'])
    expect(redirectLogs[0]).toMatchObject({ transport: 'ipv4', httpStatus: 302 })
  })

  it('follows an https redirect only onto eu.cronitor.link', async () => {
    const scripted = createScriptedCronitorConnect(({ hostname }) => {
      if (hostname === EU_IPV4) {
        return emptyOk()
      }
      return httpResponse(302, {
        Location: 'https://eu.cronitor.link/p/next?state=run',
        'Content-Length': '0',
      })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: ipv4Fetch(scripted.connect, (host) => (host === 'eu.cronitor.link' ? [EU_IPV4] : [IPV4])),
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    expect(scripted.dials.map((dial) => dial.hostname)).toEqual([IPV4, EU_IPV4, IPV4, EU_IPV4])
    expect(scripted.dials.map((dial) => dial.sni)).toEqual([
      'cronitor.link',
      'eu.cronitor.link',
      'cronitor.link',
      'eu.cronitor.link',
    ])
    expect(cronitorLogs().map((entry) => entry.message)).toEqual(['cronitor sent run', 'cronitor sent complete'])
  })

  it('uses an injected fetch, reports a socket load failure, and prefers ipv4 when connect exists', async () => {
    const injected = createCronitorFetch().fetch
    await expect(
      selectCronitorFetch(injected, async () => {
        throw new Error('load should not run')
      }),
    ).resolves.toBe(injected)

    const globalFetch = vi.fn(async () => new Response('plain-fetch-must-not-run'))
    vi.stubGlobal('fetch', globalFetch)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const unavailable = await selectCronitorFetch(undefined, async () => {
      throw new Error('https://cronitor.link/secret 44.230.87.160 sockets exploded')
    })
    const kept = await traceCronitorJob({
      env: clipEnv(),
      monitorKeyBinding: CRONITOR_CLIP_MONITOR_KEY_BINDING,
      failMessage: CRONITOR_CLIP_FAIL_MESSAGE,
      fetch: unavailable,
      job: async () => 'kept',
      metrics: () => ({ count: 1, error_count: 0 }),
    })
    expect(kept).toBe('kept')
    expect(globalFetch).not.toHaveBeenCalled()
    const failed = cronitorLogs()
    expect(failed.map((entry) => entry.message)).toEqual(['cronitor network run', 'cronitor network complete'])
    expect(failed[0]).toMatchObject({ outcome: 'network', pingState: 'run', transport: 'ipv4', cause: 'sockets' })
    expect(failed[1]).toMatchObject({ outcome: 'network', pingState: 'complete', transport: 'ipv4', cause: 'sockets' })
    const failedText = JSON.stringify(failed)
    expect(failedText).not.toContain('cronitor.link')
    expect(failedText).not.toContain('44.230.87.160')
    expect(failedText).not.toContain('exploded')
    expect(failedText).not.toContain(API_KEY)

    const scripted = createScriptedCronitorConnect(() => emptyOk())
    const doh = vi.fn(async () => new Response(JSON.stringify({ Answer: [{ type: 1, TTL: 60, data: IPV4 }] }), {
      status: 200,
    }))
    vi.stubGlobal('fetch', doh)
    const transport = await selectCronitorFetch(undefined, async () => scripted.connect)
    expect(transport).not.toBe(globalFetch)
    const response = await transport('https://cronitor.link/p/k/m?state=run', { signal: AbortSignal.timeout(1_000) })
    expect(response.status).toBe(200)
    expect(response.headers.get(CRONITOR_IPV4_HEADER)).toBe('ipv4')
    expect(scripted.dials[0]?.hostname).toBe(IPV4)
    expect(doh).toHaveBeenCalledOnce()
    expect(CronitorLinkError).toBeDefined()
  })
})
