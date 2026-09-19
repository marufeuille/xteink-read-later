import type { DetectLanguage, Language } from '../types'

const JA_CHAR = /[\u3040-\u30ff\u4e00-\u9faf]/g
const JA_RATIO = 0.08

export function extractHtmlLang(html: string): string | null {
  const match = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)
  const lang = match?.[1]?.trim()
  return lang && lang.length > 0 ? lang : null
}

export const detectLanguage: DetectLanguage = ({ htmlLang, contentHtml }): Language => {
  const lang = htmlLang?.trim().toLowerCase() ?? ''
  if (lang === 'ja' || lang.startsWith('ja-')) {
    return 'ja'
  }

  const text = contentHtml.replace(/<[^>]+>/g, '')
  const jaChars = text.match(JA_CHAR)?.length ?? 0
  const letters = text.replace(/\s+/g, '').length
  if (letters > 0 && jaChars / letters >= JA_RATIO) {
    return 'ja'
  }

  return 'non-ja'
}
