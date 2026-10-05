import { strFromU8, unzipSync } from 'fflate'

export type EpubCheck = { readonly ok: true } | { readonly ok: false; readonly errorKind: string }

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function firstLocalFile(bytes: Uint8Array): { readonly name: string; readonly method: number; readonly data: string } | null {
  if (bytes.byteLength < 30 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return null
  }
  const method = readU16(bytes, 8)
  const compressedSize = readU32(bytes, 18)
  const nameLength = readU16(bytes, 26)
  const extraLength = readU16(bytes, 28)
  const nameStart = 30
  const nameEnd = nameStart + nameLength
  const dataStart = nameEnd + extraLength
  const dataEnd = dataStart + compressedSize
  if (nameEnd > bytes.byteLength || dataEnd > bytes.byteLength) {
    return null
  }
  const name = new TextDecoder().decode(bytes.subarray(nameStart, nameEnd))
  const data = new TextDecoder().decode(bytes.subarray(dataStart, dataEnd))
  return { name, method, data }
}

export function verifySmokeEpub(bytes: Uint8Array, phrase: string): EpubCheck {
  const first = firstLocalFile(bytes)
  if (first === null) {
    return { ok: false, errorKind: 'epub_not_zip' }
  }
  if (first.name !== 'mimetype' || first.method !== 0 || first.data !== 'application/epub+zip') {
    return { ok: false, errorKind: 'epub_mimetype' }
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    return { ok: false, errorKind: 'epub_not_zip' }
  }
  const container = entries['META-INF/container.xml']
  if (container === undefined) {
    return { ok: false, errorKind: 'epub_container' }
  }
  const containerText = strFromU8(container)
  const opfPath = /full-path\s*=\s*"([^"]+)"/.exec(containerText)?.[1]
  if (opfPath === undefined) {
    return { ok: false, errorKind: 'epub_opf' }
  }
  const opf = entries[opfPath]
  if (opf === undefined) {
    return { ok: false, errorKind: 'epub_opf' }
  }
  const opfText = strFromU8(opf)
  if (!opfText.includes('<package') || !opfText.includes('</package>')) {
    return { ok: false, errorKind: 'epub_opf' }
  }
  const texts = Object.entries(entries)
    .filter(([name]) => /\.(?:xhtml|html|opf|xml)$/i.test(name))
    .map(([, data]) => strFromU8(data))
  if (!texts.some((text) => text.includes(phrase))) {
    return { ok: false, errorKind: 'epub_phrase' }
  }
  return { ok: true }
}
