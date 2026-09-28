import { assertFetchableCandidateUrl } from '../candidates/fetch-policy'
import type { EpubImage } from './build-epub'
import { toX3BaselineJpeg } from '../images/baseline-jpeg'
import {
  X3_IMAGE_MAX_COUNT,
  X3_IMAGE_MAX_HEIGHT,
  X3_IMAGE_MAX_WIDTH,
  X3_IMAGE_QUALITY,
  X3_IMAGE_SOURCE_MAX_BYTES,
} from '../images/x3-token'
import { parseHttpUrl, type HttpUrl } from '../types'

export { isX3BaselineJpeg } from '../images/baseline-jpeg'

const FIGURE_BLOCK = /<p><img src="([^"]+)" alt=""\/><\/p>/g

function unescapeAttr(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
const FETCH_TIMEOUT_MS = 8_000
const JPEG_ACCEPT = 'image/jpeg,image/*;q=0.8'

type ImageFetch = (input: string, init?: RequestInit) => Promise<Response>

const cloudflareResize = {
  redirect: 'follow' as const,
  headers: { Accept: JPEG_ACCEPT },
  cf: {
    image: {
      width: X3_IMAGE_MAX_WIDTH,
      height: X3_IMAGE_MAX_HEIGHT,
      fit: 'scale-down' as const,
      format: 'baseline-jpeg' as const,
      quality: X3_IMAGE_QUALITY,
    },
  },
}

async function jpegFromResponse(response: Response): Promise<Uint8Array | null> {
  if (!response.ok) {
    return null
  }
  if (response.url.length > 0) {
    const finalUrl = parseHttpUrl(response.url)
    if (finalUrl === null || !assertFetchableCandidateUrl(finalUrl).ok) {
      return null
    }
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > X3_IMAGE_SOURCE_MAX_BYTES) {
    return null
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return toX3BaselineJpeg(bytes)
}

async function fetchX3Jpeg(url: HttpUrl, fetchImage: ImageFetch): Promise<Uint8Array | null> {
  if (!assertFetchableCandidateUrl(url).ok) {
    return null
  }
  try {
    const resized = await fetchImage(url, {
      ...cloudflareResize,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const fromResize = await jpegFromResponse(resized)
    // A /cdn-cgi/image/ URL can fail image resizing and still be a progressive JPEG.
    if (fromResize !== null || resized.ok) {
      return fromResize
    }
  } catch {
    // The resize request failed. The raw response may still be a JPEG we can rewrite.
  }
  try {
    const raw = await fetchImage(url, {
      redirect: 'follow',
      headers: { Accept: JPEG_ACCEPT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return await jpegFromResponse(raw)
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
