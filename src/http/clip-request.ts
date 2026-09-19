import type { ClipRequestBody } from '../types'

export function isClipRequestBody(value: unknown): value is ClipRequestBody {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('url' in value)) {
    return false
  }
  return typeof value.url === 'string'
}
