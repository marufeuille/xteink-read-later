import { describe, expect, it } from 'vitest'
import { detectLanguage, extractHtmlLang } from '../src/extract/detect-language'

describe('detectLanguage', () => {
  it('trusts html lang=ja', () => {
    expect(
      detectLanguage({
        htmlLang: 'ja-JP',
        contentHtml: '<p>Hello world this is english filler text for ratio.</p>',
      }),
    ).toBe('ja')
  })

  it('detects Japanese from kana and kanji density', () => {
    expect(
      detectLanguage({
        htmlLang: null,
        contentHtml: '<p>本文抽出とEPUB生成を同時に行うならPaidプランを前提にする。</p>',
      }),
    ).toBe('ja')
  })

  it('treats ambiguous english as non-ja', () => {
    expect(
      detectLanguage({
        htmlLang: 'en',
        contentHtml: '<p>Set compatibility_date to a recent date so the Worker can use current APIs.</p>',
      }),
    ).toBe('non-ja')
  })
})

describe('extractHtmlLang', () => {
  it('reads the html lang attribute', () => {
    expect(extractHtmlLang('<html lang="ja"><body></body></html>')).toBe('ja')
    expect(extractHtmlLang('<HTML LANG="en-US">')).toBe('en-US')
    expect(extractHtmlLang('<html><body></body></html>')).toBeNull()
  })
})
