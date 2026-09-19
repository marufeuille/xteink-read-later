import type { ClipRequestBody } from '../types'

export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

export function isClipRequestBody(value: unknown): value is ClipRequestBody {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('url' in value)) {
    return false
  }
  return typeof value.url === 'string'
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function shareTextFromJson(raw: string): string | null {
  let body: unknown
  try {
    body = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (isClipRequestBody(body)) {
    return body.url
  }
  if (typeof body === 'object' && body !== null && 'text' in body) {
    return nonEmptyString(body.text)
  }
  return null
}

export function parseClipShareText(contentType: string | undefined, raw: string): string | null {
  const media = mediaTypeOf(contentType)
  if (media === 'text/plain') {
    const trimmed = raw.trim()
    return trimmed === '' ? null : trimmed
  }
  if (media === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(raw)
    return nonEmptyString(params.get('url')) ?? nonEmptyString(params.get('text')) ?? nonEmptyString(params.get('link'))
  }
  return shareTextFromJson(raw)
}
