const INK_CHANNEL = 250
/** A row this full of non-white pixels is image ink, not a line of text. */
const DENSE_ROW_RATIO = 0.15
/** Home chrome can mark single rows. An image band is a solid run. */
const MIN_BAND_ROWS = 24
const MIN_BAND_WIDTH = 40
const COLUMN_INK_RATIO = 0.2
/** A discarded image leaves the same rectangle white. */
export const EMPTY_BAND_RATIO = 0.03

export type RgbImage = {
  readonly width: number
  readonly height: number
  readonly rgb: Uint8Array
}

export type ImageBand = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function i32(view: DataView, offset: number): number {
  return view.getInt32(offset, true)
}

function maskShift(mask: number): { readonly shift: number; readonly bits: number } {
  let shift = 0
  let rest = mask >>> 0
  while (rest !== 0 && (rest & 1) === 0) {
    rest >>>= 1
    shift += 1
  }
  let bits = 0
  while ((rest & 1) === 1) {
    rest >>>= 1
    bits += 1
  }
  return { shift, bits }
}

function channel(pixel: number, mask: number): number {
  if (mask === 0) {
    return 0
  }
  const { shift, bits } = maskShift(mask)
  const value = (pixel >>> shift) & ((1 << bits) - 1)
  if (bits >= 8) {
    return value >>> (bits - 8)
  }
  return value << (8 - bits)
}

export function decodeBmp(bytes: Uint8Array): RgbImage {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error('screenshot is not a BMP')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pixelOffset = u32(view, 10)
  const headerSize = u32(view, 14)
  const width = i32(view, 18)
  const heightRaw = i32(view, 22)
  const planes = u16(view, 26)
  const bitCount = u16(view, 28)
  const compression = u32(view, 30)
  if (width < 1 || heightRaw === 0 || planes !== 1) {
    throw new Error(`unsupported BMP geometry ${width}x${heightRaw}`)
  }
  const topDown = heightRaw < 0
  const height = Math.abs(heightRaw)
  const rgb = new Uint8Array(width * height * 3)
  const rowStride = Math.ceil((width * bitCount) / 32) * 4

  if (bitCount === 24 && compression === 0) {
    for (let y = 0; y < height; y += 1) {
      const stored = topDown ? y : height - 1 - y
      const row = pixelOffset + stored * rowStride
      for (let x = 0; x < width; x += 1) {
        const src = row + x * 3
        const dst = (y * width + x) * 3
        rgb[dst] = bytes[src + 2] ?? 0
        rgb[dst + 1] = bytes[src + 1] ?? 0
        rgb[dst + 2] = bytes[src] ?? 0
      }
    }
    return { width, height, rgb }
  }

  if (bitCount === 32 && compression === 3) {
    const redMask = u32(view, 54)
    const greenMask = u32(view, 58)
    const blueMask = u32(view, 62)
    if (headerSize < 40 || pixelOffset < 66) {
      throw new Error('32-bit BMP is missing channel masks')
    }
    for (let y = 0; y < height; y += 1) {
      const stored = topDown ? y : height - 1 - y
      const row = pixelOffset + stored * rowStride
      for (let x = 0; x < width; x += 1) {
        const pixel = u32(view, row + x * 4)
        const dst = (y * width + x) * 3
        rgb[dst] = channel(pixel, redMask)
        rgb[dst + 1] = channel(pixel, greenMask)
        rgb[dst + 2] = channel(pixel, blueMask)
      }
    }
    return { width, height, rgb }
  }

  throw new Error(`unsupported BMP ${bitCount}-bit compression ${compression}`)
}

export function encodeBmp(image: RgbImage): Uint8Array {
  const rowStride = Math.ceil((image.width * 3) / 4) * 4
  const pixelBytes = rowStride * image.height
  const bytes = new Uint8Array(54 + pixelBytes)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, image.width, true)
  view.setInt32(22, image.height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, pixelBytes, true)
  for (let y = 0; y < image.height; y += 1) {
    const stored = image.height - 1 - y
    const row = 54 + stored * rowStride
    for (let x = 0; x < image.width; x += 1) {
      const src = (y * image.width + x) * 3
      const dst = row + x * 3
      bytes[dst] = image.rgb[src + 2] ?? 0
      bytes[dst + 1] = image.rgb[src + 1] ?? 0
      bytes[dst + 2] = image.rgb[src] ?? 0
    }
  }
  return bytes
}

function isInk(rgb: Uint8Array, index: number): boolean {
  const r = rgb[index] ?? 255
  const g = rgb[index + 1] ?? 255
  const b = rgb[index + 2] ?? 255
  return r < INK_CHANNEL || g < INK_CHANNEL || b < INK_CHANNEL
}

function rowInkRatio(image: RgbImage, y: number): number {
  let ink = 0
  const start = y * image.width * 3
  for (let x = 0; x < image.width; x += 1) {
    if (isInk(image.rgb, start + x * 3)) {
      ink += 1
    }
  }
  return ink / image.width
}

export function inkRatio(image: RgbImage, band: ImageBand): number {
  let ink = 0
  let total = 0
  for (let y = band.y; y < band.y + band.height; y += 1) {
    for (let x = band.x; x < band.x + band.width; x += 1) {
      total += 1
      if (isInk(image.rgb, (y * image.width + x) * 3)) {
        ink += 1
      }
    }
  }
  return total === 0 ? 0 : ink / total
}

/** Solid non-white rectangle. Text and home chrome stay below the row run. */
export function findImageBand(image: RgbImage): ImageBand | null {
  let bestStart = 0
  let bestHeight = 0
  let y = 0
  while (y < image.height) {
    if (rowInkRatio(image, y) < DENSE_ROW_RATIO) {
      y += 1
      continue
    }
    const start = y
    while (y < image.height && rowInkRatio(image, y) >= DENSE_ROW_RATIO) {
      y += 1
    }
    const height = y - start
    if (height >= MIN_BAND_ROWS && height > bestHeight) {
      bestStart = start
      bestHeight = height
    }
  }
  if (bestHeight < MIN_BAND_ROWS) {
    return null
  }

  let x0 = image.width
  let x1 = -1
  for (let x = 0; x < image.width; x += 1) {
    let ink = 0
    for (let row = bestStart; row < bestStart + bestHeight; row += 1) {
      if (isInk(image.rgb, (row * image.width + x) * 3)) {
        ink += 1
      }
    }
    if (ink / bestHeight >= COLUMN_INK_RATIO) {
      if (x < x0) {
        x0 = x
      }
      x1 = x
    }
  }
  if (x1 < x0 || x1 - x0 + 1 < MIN_BAND_WIDTH) {
    return null
  }
  return { x: x0, y: bestStart, width: x1 - x0 + 1, height: bestHeight }
}
