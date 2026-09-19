import { createExtractPipeline } from '../extract/pipeline'
import { logPipeline } from '../log'
import type {
  ClipTranslateTimingsMs,
  ExtractPipeline,
  HttpUrl,
  PipelineError,
  Result,
  TranslateArticle,
  TranslateDeps,
  TranslatedArticle,
  ArticleId,
} from '../types'
import { translateArticle as defaultTranslateArticle } from './openai'

export type TranslatedResult = {
  readonly id: ArticleId
  readonly article: TranslatedArticle
  readonly timingsMs: ClipTranslateTimingsMs
}

export type TranslatePipeline = (
  url: HttpUrl,
  deps: TranslateDeps,
) => Promise<Result<TranslatedResult, PipelineError>>

export function createTranslatePipeline(
  deps: {
    readonly extractPipeline?: ExtractPipeline
    readonly translateArticle?: TranslateArticle
  } = {},
): TranslatePipeline {
  const extractPipeline = deps.extractPipeline ?? createExtractPipeline()
  const translateArticle = deps.translateArticle ?? defaultTranslateArticle

  return async (url, translateDeps) => {
    const extracted = await extractPipeline(url)
    if (!extracted.ok) {
      return extracted
    }

    const started = Date.now()
    const translated = await translateArticle(extracted.value.article, translateDeps)
    const translateMs = Date.now() - started
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
    return {
      ok: true,
      value: {
        id: extracted.value.id,
        article: translated.value,
        timingsMs: {
          fetch: extracted.value.timingsMs.fetch,
          extract: extracted.value.timingsMs.extract,
          translate: translateMs,
        },
      },
    }
  }
}

export const translatePipeline = createTranslatePipeline()
