import type { HttpUrl, InvalidUrlError, Result } from '../types'
import { err, ok } from '../types'

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
  'metadata.internal',
  '169.254.169.254',
])

function ipv4Octets(hostname: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (match === null) {
    return null
  }
  const octets = match.slice(1).map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null
  }
  return octets
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = ipv4Octets(hostname)
  if (octets === null) {
    return false
  }
  const [a, b] = octets
  if (a === undefined || b === undefined) {
    return false
  }
  if (a === 10 || a === 127 || a === 0) {
    return true
  }
  if (a === 169 && b === 254) {
    return true
  }
  if (a === 192 && b === 168) {
    return true
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  return false
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true
  }
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }
  return false
}

export function isBlockedCandidateHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase()
  if (BLOCKED_HOSTS.has(host)) {
    return true
  }
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  return isPrivateIpv4(host) || isPrivateIpv6(host)
}

export function assertFetchableCandidateUrl(url: HttpUrl): Result<HttpUrl, InvalidUrlError> {
  const parsed = new URL(url)
  if (isBlockedCandidateHost(parsed.hostname)) {
    return err({ kind: 'invalid_url', url })
  }
  return ok(url)
}
