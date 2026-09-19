import { describe, expect, it } from 'vitest'
import {
  charsetFromContentType,
  charsetFromMeta,
  decodeHtmlBytes,
  normalizeEncodingLabel,
} from '../src/extract/html-encoding'

const NIHONGO_SJIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])
const NIHONGO_EUCJP = new Uint8Array([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec])
const NIHONGO_UTF8 = new TextEncoder().encode('日本語')

function withPrefix(prefix: string, payload: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(prefix)
  const bytes = new Uint8Array(head.length + payload.length)
  bytes.set(head, 0)
  bytes.set(payload, head.length)
  return bytes
}

describe('charset helpers', () => {
  it('reads charset from Content-Type', () => {
    expect(charsetFromContentType('text/html; charset=Shift_JIS')).toBe('Shift_JIS')
    expect(charsetFromContentType('text/html')).toBeNull()
  })

  it('reads charset from meta tags', () => {
    expect(charsetFromMeta('<meta charset="euc-jp">')).toBe('euc-jp')
    expect(
      charsetFromMeta(
        '<meta http-equiv="Content-Type" content="text/html; charset=windows-31j">',
      ),
    ).toBe('windows-31j')
    expect(
      charsetFromMeta(
        '<meta content="text/html; charset=Shift_JIS" http-equiv="Content-Type">',
      ),
    ).toBe('Shift_JIS')
  })

  it('normalizes encoding aliases', () => {
    expect(normalizeEncodingLabel('Windows-31J')).toBe('shift_jis')
    expect(normalizeEncodingLabel('eucjp')).toBe('euc-jp')
    expect(normalizeEncodingLabel('utf8')).toBe('utf-8')
  })
})

describe('decodeHtmlBytes', () => {
  it('sniffs Shift_JIS from a meta charset when Content-Type omits it', () => {
    const result = decodeHtmlBytes(
      withPrefix('<html><head><meta charset="Shift_JIS"></head><body>', NIHONGO_SJIS),
      'text/html',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.html).toContain('日本語')
    expect(result.encoding).toBe('shift_jis')
  })

  it('sniffs Shift_JIS from http-equiv Content-Type', () => {
    const result = decodeHtmlBytes(
      withPrefix(
        '<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head><body>',
        NIHONGO_SJIS,
      ),
      'text/html',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.html).toContain('日本語')
  })

  it('decodes EUC-JP from a meta charset', () => {
    const result = decodeHtmlBytes(
      withPrefix('<html><head><meta charset="EUC-JP"></head><body>', NIHONGO_EUCJP),
      'text/html',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.html).toContain('日本語')
    expect(result.encoding).toBe('euc-jp')
  })

  it('prefers Content-Type charset over a conflicting meta charset', () => {
    const result = decodeHtmlBytes(
      withPrefix('<html><head><meta charset="Shift_JIS"></head><body>', NIHONGO_UTF8),
      'text/html; charset=utf-8',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.html).toContain('日本語')
    expect(result.encoding).toBe('utf-8')
  })

  it('strips a UTF-8 BOM and decodes as UTF-8', () => {
    const html = new TextEncoder().encode('<html><body>日本語</body></html>')
    const bytes = new Uint8Array(3 + html.length)
    bytes.set([0xef, 0xbb, 0xbf], 0)
    bytes.set(html, 3)
    const result = decodeHtmlBytes(bytes, 'text/html; charset=Shift_JIS')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.html).toContain('日本語')
    expect(result.encoding).toBe('utf-8')
  })

  it('fails explicitly for an unsupported charset', () => {
    const result = decodeHtmlBytes(
      new TextEncoder().encode('<html><body>hi</body></html>'),
      'text/html; charset=x-unknown-set',
    )
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('Unsupported HTML charset')
  })
})
