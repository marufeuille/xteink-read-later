import { createExtractPipeline } from '../extract/pipeline'
import { buildEpub } from '../epub/build-epub'
import { logPipeline } from '../log'
import { translateArticle as defaultTranslateArticle } from '../translate/openai'
import type {
  BuildEpub,
  ClipPipeline,
  ExtractPipeline,
  TranslateArticle,
} from '../types'

export function createClipPipeline(
  deps: {
    readonly extractPipeline?: ExtractPipeline
    readonly translateArticle?: TranslateArticle
    readonly buildEpub?: BuildEpub
  } = {},
): ClipPipeline {
  const extractPipeline = deps.extractPipeline ?? createExtractPipeline()
  const translateArticle = deps.translateArticle ?? defaultTranslateArticle
  const build = deps.buildEpub ?? buildEpub

  return async (url, translateDeps) => {
    const extracted = await extractPipeline(url)
    if (!extracted.ok) {
      return extracted
    }

    const translateStarted = Date.now()
    const translated = await translateArticle(extracted.value.article, translateDeps)
    const translateMs = Date.now() - translateStarted
    if (!translated.ok) {
      logPipeline({
        articleId: extracted.value.id,
        stage: 'translate',
        durationMs: translateMs,
        errorKind: translated.error.kind,
      })
      return translated
    }
    logPipeline({
      articleId: extracted.value.id,
      stage: 'translate',
      durationMs: translateMs,
    })

    const epubStarted = Date.now()
    try {
      const epub = await build(translated.value)
      const epubMs = Date.now() - epubStarted
      logPipeline({
        articleId: extracted.value.id,
        stage: 'epub',
        durationMs: epubMs,
      })
      return {
        ok: true,
        value: {
          id: extracted.value.id,
          article: translated.value,
          epub,
          timingsMs: {
            fetch: extracted.value.timingsMs.fetch,
            extract: extracted.value.timingsMs.extract,
            translate: translateMs,
            epub: epubMs,
          },
        },
      }
    } catch (cause) {
      const epubMs = Date.now() - epubStarted
      const reason = cause instanceof Error ? cause.message : String(cause)
      logPipeline({
        articleId: extracted.value.id,
        stage: 'epub',
        durationMs: epubMs,
        errorKind: 'extract_failed',
      })
      return {
        ok: false,
        error: {
          kind: 'extract_failed',
          url,
          reason: `EPUB generation failed: ${reason}`,
        },
      }
    }
  }
}

export const clipPipeline = createClipPipeline()
