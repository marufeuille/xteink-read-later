import type { CronitorConnect, CronitorSocket } from '../src/telemetry/cronitor-ipv4'

export type ScriptedDial = {
  hostname: string
  port: number
  sni: string | undefined
  request: string
}

export type ScriptedPlanned =
  | Uint8Array
  | { readonly bytes: Uint8Array; readonly eof: true }
  | 'hang'
  | 'read-error'
  | 'eof'
  | Error

export function bytesThenEof(bytes: Uint8Array): { readonly bytes: Uint8Array; readonly eof: true } {
  return { bytes, eof: true }
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
  respond: (dial: { readonly hostname: string }) => ScriptedPlanned,
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
    let writeClosed = false
    let delivered = false
    let armed = false
    const readable = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
      },
      pull(next) {
        if (planned === 'read-error') {
          next.error(new TypeError('read-failed-token'))
        }
      },
    })
    const enqueue = (bytes: Uint8Array): void => {
      if (delivered || controller === undefined) {
        return
      }
      delivered = true
      const midpoint = Math.floor(bytes.byteLength / 2)
      if (midpoint > 0 && midpoint < bytes.byteLength) {
        controller.enqueue(bytes.slice(0, midpoint))
        controller.enqueue(bytes.slice(midpoint))
        return
      }
      controller.enqueue(bytes)
    }
    const drop = (): void => {
      if (delivered) {
        return
      }
      delivered = true
      try {
        controller?.close()
      } catch {
        // The reader may already have cancelled the stream.
      }
    }
    // The response is produced only after the request bytes are written, and only
    // if the write side is still open. Closing it first models TLS close_notify:
    // nginx has the ping, but the readable ends with no HTTP bytes.
    const arm = (): void => {
      if (armed) {
        return
      }
      armed = true
      setTimeout(() => {
        if (writeClosed || planned === 'hang' || planned === 'read-error') {
          return
        }
        if (planned === 'eof') {
          drop()
          return
        }
        if (typeof planned === 'object' && 'eof' in planned) {
          enqueue(planned.bytes)
          try {
            controller?.close()
          } catch {
            // EOF after a partial body. The reader may already be gone.
          }
          return
        }
        enqueue(planned)
      }, 0)
    }
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        dial.request += new TextDecoder().decode(chunk)
        if (dial.request.includes('\r\n\r\n') && planned !== 'hang' && planned !== 'read-error') {
          arm()
        }
      },
      close() {
        writeClosed = true
        if (planned === 'hang' || planned === 'read-error' || delivered) {
          return
        }
        drop()
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
        dial.sni = options?.expectedServerHostname ?? address.hostname
        return tls
      },
    }
    return tls
  }
  return { connect, dials }
}
