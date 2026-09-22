import { strFromU8, unzipSync } from 'fflate'

const MAX_METADATA_UNCOMPRESSED_BYTES = 1_000_000
const MAX_METADATA_TEXT_CHARS = 1000

export type EpubPackageMetadata = {
  readonly title: string | null
  readonly creator: string | null
}

const EMPTY_METADATA: EpubPackageMetadata = { title: null, creator: null }

function isSafeZipPath(name: string): boolean {
  if (name.length === 0 || name.length > 240) {
    return false
  }
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
    return false
  }
  const parts = name.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  const value = (match?.[1] ?? match?.[2])?.trim() ?? ''
  return value === '' ? null : value
}

function rootfilePath(containerXml: string): string | null {
  const tags = containerXml.match(/<rootfile\b[^>]*>/gi) ?? []
  let fallback: string | null = null
  for (const tag of tags) {
    const path = attr(tag, 'full-path')
    if (path === null || !isSafeZipPath(path)) {
      continue
    }
    if (attr(tag, 'media-type') === 'application/oebps-package+xml') {
      return path
    }
    if (fallback === null) {
      fallback = path
    }
  }
  return fallback
}

function decodeCodePoint(code: number, raw: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return raw
  }
  return String.fromCodePoint(code)
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (raw, hex: string) => decodeCodePoint(Number.parseInt(hex, 16), raw))
    .replace(/&#([0-9]{1,7});/g, (raw, dec: string) => decodeCodePoint(Number.parseInt(dec, 10), raw))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function normalizeXmlText(raw: string): string | null {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  const decoded = decodeXmlEntities(withoutCdata.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  if (decoded === '') {
    return null
  }
  return decoded.length > MAX_METADATA_TEXT_CHARS ? decoded.slice(0, MAX_METADATA_TEXT_CHARS) : decoded
}

function firstDc(xml: string, local: 'title' | 'creator'): string | null {
  const pattern = new RegExp(`<dc:${local}\\b[^>]*>([\\s\\S]*?)</dc:${local}>`, 'gi')
  for (const match of xml.matchAll(pattern)) {
    const text = normalizeXmlText(match[1] ?? '')
    if (text !== null) {
      return text
    }
  }
  return null
}

function readZipText(bytes: Uint8Array, name: string): string | null {
  if (!isSafeZipPath(name)) {
    return null
  }
  const files = unzipSync(bytes, {
    filter(file) {
      return (
        file.name === name &&
        file.originalSize <= MAX_METADATA_UNCOMPRESSED_BYTES &&
        (file.compression === 0 || file.compression === 8)
      )
    },
  })
  const entry = files[name]
  if (entry === undefined || entry.byteLength > MAX_METADATA_UNCOMPRESSED_BYTES) {
    return null
  }
  return strFromU8(entry)
}

export function readEpubPackageMetadata(bytes: Uint8Array): EpubPackageMetadata {
  try {
    const container = readZipText(bytes, 'META-INF/container.xml')
    if (container === null) {
      return EMPTY_METADATA
    }
    const opfPath = rootfilePath(container)
    if (opfPath === null) {
      return EMPTY_METADATA
    }
    const opf = readZipText(bytes, opfPath)
    if (opf === null) {
      return EMPTY_METADATA
    }
    return {
      title: firstDc(opf, 'title'),
      creator: firstDc(opf, 'creator'),
    }
  } catch {
    return EMPTY_METADATA
  }
}
