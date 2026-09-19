import type { ClipRequestBody, HttpUrl, InvalidUrlError, ParseClipUrl, Result } from '../types'
import { err, ok, parseHttpUrl } from '../types'

export const parseClipUrl: ParseClipUrl = (
  body: ClipRequestBody,
): Result<HttpUrl, InvalidUrlError> => {
  const url = parseHttpUrl(body.url.trim())
  if (url === null) {
    return err({ kind: 'invalid_url', url: body.url })
  }
  return ok(url)
}
