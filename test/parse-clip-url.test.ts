import { describe, expect, it } from 'vitest'
import { parseClipUrl } from '../src/extract/parse-clip-url'

describe('parseClipUrl', () => {
  it('accepts http and https URLs', () => {
    const https = parseClipUrl({ url: 'https://example.com/a' })
    expect(https.ok).toBe(true)
    const http = parseClipUrl({ url: 'http://example.com/a' })
    expect(http.ok).toBe(true)
  })

  it('trims surrounding whitespace', () => {
    const parsed = parseClipUrl({ url: '  https://example.com/a  ' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.value).toBe('https://example.com/a')
  })

  it('rejects non-http schemes and malformed values', () => {
    expect(parseClipUrl({ url: 'ftp://example.com/a' }).ok).toBe(false)
    expect(parseClipUrl({ url: 'javascript:alert(1)' }).ok).toBe(false)
    expect(parseClipUrl({ url: 'not-a-url' }).ok).toBe(false)
    expect(parseClipUrl({ url: '' }).ok).toBe(false)
  })
})
