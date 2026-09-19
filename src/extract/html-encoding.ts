const ENCODING_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'utf-16': 'utf-16',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'shift-jis': 'shift_jis',
  shift_jis: 'shift_jis',
  sjis: 'shift_jis',
  csshiftjis: 'shift_jis',
  'windows-31j': 'shift_jis',
  'windows-932': 'shift_jis',
  ms932: 'shift_jis',
  'euc-jp': 'euc-jp',
  eucjp: 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
  'iso-8859-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
  'windows-1252': 'windows-1252',
  gbk: 'gbk',
  gb2312: 'gbk',
  big5: 'big5',
}

export function charsetFromContentType(contentType: string): string | null {
  const match = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(contentType)
  const charset = match?.[1]?.trim()
  return charset !== undefined && charset.length > 0 ? charset : null
}

export function charsetFromMeta(htmlPrefix: string): string | null {
  const charsetAttr = /<meta\b[^>]*\bcharset\s*=\s*["']?([a-z0-9._-]+)/i.exec(htmlPrefix)
  if (charsetAttr?.[1] !== undefined) {
    return charsetAttr[1]
  }
  const httpEquiv = /<meta\b[^>]*http-equiv\s*=\s*["']?content-type["'][^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i.exec(
    htmlPrefix,
  )
  if (httpEquiv?.[1] !== undefined) {
    return httpEquiv[1]
  }
  const contentFirst = /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)[^"']*["'][^>]*http-equiv\s*=\s*["']?content-type/i.exec(
    htmlPrefix,
  )
  return contentFirst?.[1] ?? null
}

export function normalizeEncodingLabel(label: string): string {
  const key = label.trim().toLowerCase().replaceAll('_', '-')
  return ENCODING_ALIASES[key] ?? key
}

function decoderFor(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label)
  } catch {
    return null
  }
}

export type DecodeHtmlResult =
  | { readonly ok: true; readonly html: string; readonly encoding: string }
  | { readonly ok: false; readonly reason: string }

export function decodeHtmlBytes(bytes: Uint8Array, contentType: string): DecodeHtmlResult {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: true, html: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' }
  }

  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
  const declared = charsetFromContentType(contentType) ?? charsetFromMeta(prefix) ?? 'utf-8'
  const encoding = normalizeEncodingLabel(declared)
  const decoder = decoderFor(encoding) ?? decoderFor(declared)
  if (decoder === null) {
    return { ok: false, reason: `Unsupported HTML charset: ${declared}` }
  }
  return { ok: true, html: decoder.decode(bytes), encoding }
}
