import { parseHttpUrl, type HttpUrl } from '../types'

/** X3 portrait is 528×792. Stay inside that box so CrossPoint's bounds check still draws the image. */
export const X3_IMAGE_MAX_WIDTH = 448
export const X3_IMAGE_MAX_HEIGHT = 640
export const X3_IMAGE_QUALITY = 72
export const X3_IMAGE_MAX_COUNT = 12
export const X3_IMAGE_MAX_BYTES = 400_000
/** Raw response cap. The embedded file still has to fit in {@link X3_IMAGE_MAX_BYTES}. */
export const X3_IMAGE_SOURCE_MAX_BYTES = 8_000_000

/** encodeURIComponent never emits `|`, so a caption can sit on the same line and still split off. */
const ENCODED_URL = /^[A-Za-z0-9\-_.!~*'()%]+/

export type X3ImageMatch = {
  readonly url: HttpUrl
  readonly rest: string
}

export function x3ImageMarker(index: number, url: string): string {
  return `X3IMG:${index}:${encodeURIComponent(url)}|`
}

/**
 * A whole line that is only a Markdown link around an image placeholder.
 * The link target is the article's lightbox URL, not the image bytes.
 */
const LINKED_IMAGE_LINE = /^\[([\s\S]+)\]\((https?:\/\/[^)\s]+)\)\s*$/

/**
 * Image placeholder at the start of a line, or a whole line that is a Markdown
 * link whose label is that placeholder.
 * `X3IMG:n:encoded|caption` splits on `|`.
 * `X3IMG:n:https://… caption` takes the raw URL until whitespace or `|`.
 * A legacy line that is only `X3IMG:n:encoded` still matches.
 * Alphanumeric caption glued on with no `|` or space stays text: the URL boundary is ambiguous.
 */
export function x3ImageFromLine(line: string): X3ImageMatch | null {
  const header = /^X3IMG:([1-9]\d{0,2}):([\s\S]*)$/.exec(imagePlaceholderText(line))
  if (header === null) {
    return null
  }
  const payload = header[2] ?? ''
  const parts = splitImagePayload(payload)
  if (parts === null) {
    return null
  }
  const url = decodeImageUrl(parts.encoded)
  if (url === null) {
    return null
  }
  return { url, rest: parts.rest }
}

/** Absolute http(s) URL from a placeholder line, or null when the line is not one. */
export function x3ImageUrlFromLine(line: string): HttpUrl | null {
  return x3ImageFromLine(line)?.url ?? null
}

function imagePlaceholderText(line: string): string {
  const trimmed = line.trim()
  const linked = LINKED_IMAGE_LINE.exec(trimmed)
  const label = linked?.[1]?.trim()
  const href = linked?.[2]
  if (label === undefined || href === undefined || parseHttpUrl(href) === null) {
    return trimmed
  }
  if (!/^X3IMG:[1-9]\d{0,2}:/.test(label)) {
    return trimmed
  }
  return label
}

function splitImagePayload(payload: string): { readonly encoded: string; readonly rest: string } | null {
  if (payload.startsWith('http://') || payload.startsWith('https://')) {
    const cut = payload.search(/[\s|]/)
    if (cut === -1) {
      return { encoded: payload, rest: '' }
    }
    const rest = payload.slice(cut).replace(/^\|/, '').trim()
    return { encoded: payload.slice(0, cut), rest }
  }
  const encodedMatch = ENCODED_URL.exec(payload)
  if (encodedMatch === null) {
    return null
  }
  const encoded = encodedMatch[0]
  const tail = payload.slice(encoded.length)
  if (tail.length === 0) {
    return { encoded, rest: '' }
  }
  if (tail.startsWith('|')) {
    return { encoded, rest: tail.slice(1).trim() }
  }
  return null
}

function decodeImageUrl(value: string): HttpUrl | null {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return parseHttpUrl(value)
  }
  try {
    return parseHttpUrl(decodeURIComponent(value))
  } catch {
    return null
  }
}
