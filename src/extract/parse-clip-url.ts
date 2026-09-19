import type { ClipRequestBody, HttpUrl, InvalidUrlError, ParseClipUrl, Result } from '../types'
import { err, ok, parseHttpUrl } from '../types'

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）】\]}>]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?。、]+$/u

function stripTrailingPunctuation(value: string): string {
  return value.replace(TRAILING_PUNCTUATION, '')
}

export function extractHttpUrlFromText(text: string): HttpUrl | null {
  const trimmed = text.trim()
  if (trimmed === '') {
    return null
  }

  const direct = parseHttpUrl(trimmed)
  if (direct !== null) {
    return direct
  }

  const angle = /^<([^>]+)>$/.exec(trimmed)
  if (angle?.[1] !== undefined) {
    const inner = parseHttpUrl(angle[1].trim())
    if (inner !== null) {
      return inner
    }
  }

  const matches = trimmed.match(URL_IN_TEXT)
  if (matches === null) {
    return null
  }
  for (const match of matches) {
    const parsed = parseHttpUrl(stripTrailingPunctuation(match))
    if (parsed !== null) {
      return parsed
    }
  }
  return null
}

export const parseClipUrl: ParseClipUrl = (
  body: ClipRequestBody,
): Result<HttpUrl, InvalidUrlError> => {
  const url = extractHttpUrlFromText(body.url)
  if (url === null) {
    return err({ kind: 'invalid_url', url: body.url })
  }
  return ok(url)
}
