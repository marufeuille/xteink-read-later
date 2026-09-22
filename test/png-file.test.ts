import { crc32 } from 'node:zlib'
import { deflateSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readRgbPng } from './png-file'

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, typeBytes.length)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(crcInput) >>> 0)
  return out
}

/** One white RGB pixel. IDAT bytes are whatever the caller passes. */
function pngWithIdat(idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, 1)
  header.setUint32(4, 1)
  ihdr[8] = 8
  ihdr[9] = 2
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array()),
  ]
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

describe('readRgbPng', () => {
  it('rejects a CRC-valid PNG whose IDAT is raw deflate', () => {
    const png = pngWithIdat(deflateSync(Uint8Array.of(0, 255, 255, 255), { level: 9 }))
    expect(() => readRgbPng(png)).toThrow(/zlib/)
  })
})
