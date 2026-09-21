import type { PayloadTooLargeError, Result } from '../types'
import { err, ok } from '../types'

export async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Result<Uint8Array, PayloadTooLargeError>> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      return err({ kind: 'payload_too_large', bytes })
    }
  }

  const body = response.body
  if (body === null) {
    return ok(new Uint8Array())
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value === undefined) {
        continue
      }
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel()
        return err({ kind: 'payload_too_large', bytes: received })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return ok(bytes)
}
