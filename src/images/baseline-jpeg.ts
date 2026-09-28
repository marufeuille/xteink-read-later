import { decode, encode } from 'jpeg-js'
import {
  X3_IMAGE_MAX_BYTES,
  X3_IMAGE_MAX_HEIGHT,
  X3_IMAGE_MAX_WIDTH,
  X3_IMAGE_QUALITY,
  X3_IMAGE_SOURCE_MAX_BYTES,
} from './x3-token'

/** Stay under a Workers memory spike. A larger photo is dropped, not fatal to the article. */
const MAX_SOURCE_PIXELS = 12_000_000

type JpegFrame = {
  readonly width: number
  readonly height: number
  readonly baseline: boolean
}

function jpegFrame(bytes: Uint8Array): JpegFrame | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }
  let index = 2
  while (index + 4 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1
      continue
    }
    const marker = bytes[index + 1] ?? 0
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2
      continue
    }
    const length = ((bytes[index + 2] ?? 0) << 8) | (bytes[index + 3] ?? 0)
    if (length < 2 || index + 2 + length > bytes.length) {
      return null
    }
    if (marker === 0xda) {
      return null
    }
    // SOF0 is baseline. SOF2 is progressive. CrossPoint draws baseline only.
    if (marker === 0xc0 || marker === 0xc2) {
      if (length < 7) {
        return null
      }
      const height = ((bytes[index + 5] ?? 0) << 8) | (bytes[index + 6] ?? 0)
      const width = ((bytes[index + 7] ?? 0) << 8) | (bytes[index + 8] ?? 0)
      if (width < 1 || height < 1) {
        return null
      }
      return { width, height, baseline: marker === 0xc0 }
    }
    index += 2 + length
  }
  return null
}

/** True when CrossPoint can draw this file without a rewrite. */
export function isX3BaselineJpeg(bytes: Uint8Array): boolean {
  const frame = jpegFrame(bytes)
  if (frame === null || !frame.baseline) {
    return false
  }
  if (bytes.byteLength > X3_IMAGE_MAX_BYTES) {
    return false
  }
  return frame.width <= X3_IMAGE_MAX_WIDTH && frame.height <= X3_IMAGE_MAX_HEIGHT
}

function fittedSize(width: number, height: number): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, X3_IMAGE_MAX_WIDTH / width, X3_IMAGE_MAX_HEIGHT / height)
  return {
    width: Math.min(X3_IMAGE_MAX_WIDTH, Math.max(1, Math.round(width * scale))),
    height: Math.min(X3_IMAGE_MAX_HEIGHT, Math.max(1, Math.round(height * scale))),
  }
}

function downsample(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const dst = new Uint8Array(dw * dh * 4)
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor((y * sh) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh))
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor((x * sw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw))
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      let count = 0
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const pixel = (yy * sw + xx) * 4
          red += src[pixel] ?? 0
          green += src[pixel + 1] ?? 0
          blue += src[pixel + 2] ?? 0
          alpha += src[pixel + 3] ?? 0
          count += 1
        }
      }
      const out = (y * dw + x) * 4
      dst[out] = Math.round(red / count)
      dst[out + 1] = Math.round(green / count)
      dst[out + 2] = Math.round(blue / count)
      dst[out + 3] = Math.round(alpha / count)
    }
  }
  return dst
}

/**
 * Baseline JPEG inside the X3 box.
 * An already-valid file is returned unchanged. Progressive and oversized JPEGs are re-encoded.
 * Anything that is not a decodable JPEG is dropped.
 */
export function toX3BaselineJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength > X3_IMAGE_SOURCE_MAX_BYTES) {
    return null
  }
  if (isX3BaselineJpeg(bytes)) {
    return bytes
  }
  const frame = jpegFrame(bytes)
  if (frame === null || frame.width * frame.height > MAX_SOURCE_PIXELS) {
    return null
  }
  try {
    const decoded = decode(bytes, { useTArray: true, formatAsRGBA: true })
    if (decoded.width < 1 || decoded.height < 1) {
      return null
    }
    if (decoded.data.length < decoded.width * decoded.height * 4) {
      return null
    }
    const size = fittedSize(decoded.width, decoded.height)
    const rgba =
      size.width === decoded.width && size.height === decoded.height
        ? decoded.data
        : downsample(decoded.data, decoded.width, decoded.height, size.width, size.height)
    const encoded = encode({ data: rgba, width: size.width, height: size.height }, X3_IMAGE_QUALITY)
    const out = new Uint8Array(encoded.data)
    return isX3BaselineJpeg(out) ? out : null
  } catch {
    return null
  }
}
