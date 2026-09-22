import { zlibSync } from 'fflate'
import { encode } from 'uqr'

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
const CRC_TABLE = buildCrcTable()
const MODULE_SCALE = 6

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let crc = n
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[n] = crc >>> 0
  }
  return table
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, typeBytes.length)
  const out = new Uint8Array(8 + data.length + 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

function encodeRgbPng(width: number, height: number, scanlines: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, width)
  header.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  // IDAT is a zlib stream. Raw deflate is not a PNG; CrossPoint then shows "[Image: 全文を送る]".
  const idat = zlibSync(scanlines, { level: 9 })
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

/** White-background, non-interlaced RGB PNG. The same text always yields the same bytes. */
export function qrPng(text: string): Uint8Array {
  const qr = encode(text, { ecc: 'M', border: 4 })
  const size = qr.size * MODULE_SCALE
  const scanlines = new Uint8Array((size * 3 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1)
    scanlines[row] = 0
    const moduleY = Math.floor(y / MODULE_SCALE)
    const modules = qr.data[moduleY]
    for (let x = 0; x < size; x += 1) {
      const dark = modules?.[Math.floor(x / MODULE_SCALE)] === true
      const value = dark ? 0 : 255
      const pixel = row + 1 + x * 3
      scanlines[pixel] = value
      scanlines[pixel + 1] = value
      scanlines[pixel + 2] = value
    }
  }
  return encodeRgbPng(size, size, scanlines)
}
