import type { CronitorConnect, CronitorSocket } from '../src/telemetry/cronitor-ipv4'

export type ScriptedDial = {
  hostname: string
  port: number
  sni: string | undefined
  request: string
}

export function httpResponse(
  status: number,
  headers: Readonly<Record<string, string>>,
  body = '',
): Uint8Array {
  const head = [`HTTP/1.1 ${status} OK`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join(
    '\r\n',
  )
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`)
}

export function createScriptedCronitorConnect(
  respond: (dial: { readonly hostname: string }) => Uint8Array | 'hang' | Error,
): {
  readonly connect: CronitorConnect
  readonly dials: readonly ScriptedDial[]
} {
  const dials: ScriptedDial[] = []
  const connect: CronitorConnect = (address) => {
    const dial: ScriptedDial = {
      hostname: address.hostname,
      port: address.port,
      sni: undefined,
      request: '',
    }
    dials.push(dial)
    const planned = respond({ hostname: address.hostname })
    if (planned instanceof Error) {
      throw planned
    }
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const readable = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        if (planned === 'hang') {
          return
        }
        const midpoint = Math.floor(planned.byteLength / 2)
        if (midpoint > 0 && midpoint < planned.byteLength) {
          next.enqueue(planned.slice(0, midpoint))
          next.enqueue(planned.slice(midpoint))
          return
        }
        next.enqueue(planned)
      },
    })
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        dial.request += new TextDecoder().decode(chunk)
      },
    })
    const tls: CronitorSocket = {
      readable,
      writable,
      opened: Promise.resolve(undefined),
      close() {
        try {
          controller?.close()
        } catch {
          // The reader may already have cancelled the stream.
        }
      },
      startTls(options) {
        dial.sni = options?.expectedServerHostname
        return tls
      },
    }
    return tls
  }
  return { connect, dials }
}
