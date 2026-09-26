import { assertFetchableCandidateUrl } from '../candidates/fetch-policy'
import type { EpubImage } from './build-epub'
import {
  X3_IMAGE_MAX_BYTES,
  X3_IMAGE_MAX_COUNT,
  X3_IMAGE_MAX_HEIGHT,
  X3_IMAGE_MAX_WIDTH,
  X3_IMAGE_QUALITY,
} from '../images/x3-token'
import { parseHttpUrl, type HttpUrl } from '../types'

const FIGURE_BLOCK = /<p><img src="([^"]+)" alt=""\/><\/p>/g

function unescapeAttr(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
const FETCH_TIMEOUT_MS = 8_000

type ImageFetch = (input: string, init?: RequestInit) => Promise<Response>

function jpegSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
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
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2
      continue
    }
    if (marker === 0xda) {
      return null
    }
    const length = ((bytes[index + 2] ?? 0) << 8) | (bytes[index + 3] ?? 0)
    if (length < 2 || index + 2 + length > bytes.length) {
      return null
    }
    // SOF2 is progressive. CrossPoint draws baseline JPEG; progressive stays blank or coarse.
    if (marker === 0xc2) {
      return null
    }
    if (marker === 0xc0) {
      if (length < 7) {
        return null
      }
      const height = ((bytes[index + 5] ?? 0) << 8) | (bytes[index + 6] ?? 0)
      const width = ((bytes[index + 7] ?? 0) << 8) | (bytes[index + 8] ?? 0)
      if (width < 1 || height < 1) {
        return null
      }
      if (width > X3_IMAGE_MAX_WIDTH || height > X3_IMAGE_MAX_HEIGHT) {
        return null
      }
      return { width, height }
    }
    index += 2 + length
  }
  return null
}

export function isX3BaselineJpeg(bytes: Uint8Array): boolean {
  return jpegSize(bytes) !== null
}

async function fetchX3Jpeg(url: HttpUrl, fetchImage: ImageFetch): Promise<Uint8Array | null> {
  if (!assertFetchableCandidateUrl(url).ok) {
    return null
  }
  try {
    const response = await fetchImage(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: {
        image: {
          width: X3_IMAGE_MAX_WIDTH,
          height: X3_IMAGE_MAX_HEIGHT,
          fit: 'scale-down',
          format: 'baseline-jpeg',
          quality: X3_IMAGE_QUALITY,
        },
      },
    })
    if (!response.ok) {
      return null
    }
    if (response.url.length > 0) {
      const finalUrl = parseHttpUrl(response.url)
      if (finalUrl === null || !assertFetchableCandidateUrl(finalUrl).ok) {
        return null
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > X3_IMAGE_MAX_BYTES) {
      return null
    }
    return isX3BaselineJpeg(bytes) ? bytes : null
  } catch {
    return null
  }
}

/** Replace remote figure blocks with local baseline JPEGs. A failed figure is removed, not fatal. */
export async function embedX3Images(
  html: string,
  fetchImage: ImageFetch = fetch,
): Promise<{ readonly html: string; readonly images: readonly EpubImage[] }> {
  const images: EpubImage[] = []
  let cursor = 0
  let next = ''
  for (const match of html.matchAll(FIGURE_BLOCK)) {
    const block = match[0]
    const src = match[1] ?? ''
    const start = match.index ?? 0
    next += html.slice(cursor, start)
    cursor = start + block.length
    const url = parseHttpUrl(unescapeAttr(src))
    if (url === null || images.length >= X3_IMAGE_MAX_COUNT) {
      continue
    }
    const bytes = await fetchX3Jpeg(url, fetchImage)
    if (bytes === null) {
      continue
    }
    const index = images.length + 1
    const href = `images/fig-${index}.jpg`
    images.push({ id: `fig-${index}`, href, bytes })
    next += `<p><img src="${href}" alt=""/></p>`
  }
  next += html.slice(cursor)
  return { html: next, images }
}
