import { crc32, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)

export type RgbPng = {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
  readonly interlace: number
  readonly firstPixel: readonly [number, number, number]
  readonly rowFilter: number
  readonly hasBlack: boolean
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

/**
 * Decode a PNG with Node's zlib, not fflate's raw inflate.
 * CrossPoint rejects a raw-deflate IDAT and shows the img alt text.
 */
export function readRgbPng(png: Uint8Array): RgbPng {
  if (
    png.byteLength < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((byte, index) => png[index] === byte)
  ) {
    throw new Error('missing PNG signature')
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let interlace = 1
  let sawIhdr = false
  let sawIend = false
  const idat: Uint8Array[] = []
  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset)
    const dataEnd = offset + 8 + length
    if (dataEnd + 4 > png.byteLength) {
      throw new Error('truncated PNG chunk')
    }
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8))
    const storedCrc = view.getUint32(dataEnd)
    const computedCrc = crc32(png.subarray(offset + 4, dataEnd)) >>> 0
    if (computedCrc !== storedCrc) {
      throw new Error(`bad CRC for ${type}`)
    }
    if (type === 'IHDR') {
      sawIhdr = true
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      bitDepth = png[offset + 16] ?? 0
      colorType = png[offset + 17] ?? -1
      interlace = png[offset + 20] ?? 1
    } else if (type === 'IDAT') {
      idat.push(png.subarray(offset + 8, dataEnd))
    } else if (type === 'IEND') {
      sawIend = true
      break
    }
    offset = dataEnd + 4
  }
  if (!sawIhdr || !sawIend || idat.length === 0) {
    throw new Error('incomplete PNG')
  }
  const compressed = concat(idat)
  if (compressed[0] !== 0x78) {
    throw new Error('IDAT is not a zlib stream')
  }
  const raw = inflateSync(compressed)
  const rowBytes = width * 3 + 1
  if (colorType !== 2 || raw.byteLength !== rowBytes * height) {
    throw new Error('PNG is not 8-bit RGB')
  }
  let hasBlack = false
  for (let y = 0; y < height && !hasBlack; y += 1) {
    const row = y * rowBytes
    for (let x = 0; x < width * 3; x += 1) {
      if (raw[row + 1 + x] === 0) {
        hasBlack = true
        break
      }
    }
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    firstPixel: [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0],
    rowFilter: raw[0] ?? 1,
    hasBlack,
  }
}
