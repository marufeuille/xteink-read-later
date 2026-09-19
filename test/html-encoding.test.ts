import { describe, expect, it } from 'vitest'
import { decodeHtmlBytes } from '../src/extract/html-encoding'

const NIHONGO_SJIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])

describe('decodeHtmlBytes', () => {
  it('sniffs Shift_JIS from a meta charset when Content-Type omits it', () => {
    const prefix = new TextEncoder().encode(
      '<html><head><meta charset="Shift_JIS"></head><body>',
    )
    const bytes = new Uint8Array(prefix.length + NIHONGO_SJIS.length)
    bytes.set(prefix, 0)
    bytes.set(NIHONGO_SJIS, prefix.length)
    const result = decodeHtmlBytes(bytes, 'text/html')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.html).toContain('日本語')
  })
})
