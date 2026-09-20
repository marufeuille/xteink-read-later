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

  return async (url, translateDeps, log) => {
    const extracted = await extractPipeline(url, log)
    if (!extracted.ok) {
      return extracted
    }

    const articleId = extracted.value.id
    const translateStarted = Date.now()
    const translated = await translateArticle(extracted.value.article, translateDeps)
    const translateMs = Date.now() - translateStarted
    if (!translated.ok) {
      logPipeline(
        { articleId, stage: 'translate', durationMs: translateMs, errorKind: translated.error.kind },
        log,
      )
      return translated
    }
    logPipeline({ articleId, stage: 'translate', durationMs: translateMs }, log)

    const epubStarted = Date.now()
    try {
      const epub = await build(translated.value)
      const epubMs = Date.now() - epubStarted
      logPipeline({ articleId, stage: 'epub', durationMs: epubMs }, log)
      return {
        ok: true,
        value: {
          id: articleId,
          article: translated.value,
          epub,
          timingsMs: {
            ...extracted.value.timingsMs,
            translate: translateMs,
            epub: epubMs,
          },
        },
      }
    } catch (cause) {
      const epubMs = Date.now() - epubStarted
      const reason = cause instanceof Error ? cause.message : String(cause)
      logPipeline({ articleId, stage: 'epub', durationMs: epubMs, errorKind: 'epub_failed' }, log)
      return {
        ok: false,
        error: {
          kind: 'epub_failed',
          url,
          reason: `EPUB generation failed: ${reason}`,
        },
      }
    }
  }
}

export const clipPipeline = createClipPipeline()
