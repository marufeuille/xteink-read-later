import type {
  AssignLanguage,
  ExtractedArticle,
  ExtractedContent,
  ExtractPipeline,
  FetchPage,
  Language,
} from '../types'
import { articleIdFromCanonicalUrl } from '../types'
import { detectLanguage, extractHtmlLang } from './detect-language'
import { extractArticle } from './extract-article'
import { fetchPage as defaultFetchPage } from './fetch-page'
import { logPipeline } from '../log'

export const assignLanguage: AssignLanguage = (
  content: ExtractedContent,
  language: Language,
): ExtractedArticle => {
  return { ...content, language }
}

export function createExtractPipeline(
  deps: { readonly fetchPage?: FetchPage } = {},
): ExtractPipeline {
  const fetchPage = deps.fetchPage ?? defaultFetchPage

  return async (url, log) => {
    const fetchStarted = Date.now()
    const page = await fetchPage(url)
    const fetchMs = Date.now() - fetchStarted
    if (!page.ok) {
      logPipeline({ stage: 'fetch', durationMs: fetchMs, errorKind: page.error.kind }, log)
      return page
    }
    logPipeline({ stage: 'fetch', durationMs: fetchMs }, log)

    const extractStarted = Date.now()
    const extracted = await extractArticle(page.value)
    const extractMs = Date.now() - extractStarted
    if (!extracted.ok) {
      logPipeline({ stage: 'extract', durationMs: extractMs, errorKind: extracted.error.kind }, log)
      return extracted
    }

    const language = detectLanguage({
      htmlLang: extractHtmlLang(page.value.html),
      contentHtml: extracted.value.contentHtml,
    })
    const article = assignLanguage(extracted.value, language)
    const id = await articleIdFromCanonicalUrl(article.canonicalUrl)
    logPipeline({ articleId: id, stage: 'extract', durationMs: extractMs }, log)
    return {
      ok: true,
      value: {
        id,
        article,
        timingsMs: {
          fetch: fetchMs,
          extract: extractMs,
        },
      },
    }
  }
}

export const extractPipeline = createExtractPipeline()
