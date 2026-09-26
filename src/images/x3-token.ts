import { parseHttpUrl, type HttpUrl } from '../types'

/** X3 portrait is 528×792. Stay inside that box so CrossPoint's bounds check still draws the image. */
export const X3_IMAGE_MAX_WIDTH = 448
export const X3_IMAGE_MAX_HEIGHT = 640
export const X3_IMAGE_QUALITY = 72
export const X3_IMAGE_MAX_COUNT = 12
export const X3_IMAGE_MAX_BYTES = 400_000

const TOKEN_RE = /^X3IMG:([1-9]\d{0,2}):([A-Za-z0-9\-_.!~*'()%]+)$/

export function x3ImageMarker(index: number, url: string): string {
  return `X3IMG:${index}:${encodeURIComponent(url)}`
}

/** Absolute http(s) URL from a placeholder line, or null when the line is not one. */
export function x3ImageUrlFromLine(line: string): HttpUrl | null {
  const match = TOKEN_RE.exec(line.trim())
  const encoded = match?.[2]
  if (encoded === undefined) {
    return null
  }
  try {
    return parseHttpUrl(decodeURIComponent(encoded))
  } catch {
    return null
  }
}
