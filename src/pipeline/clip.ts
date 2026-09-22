import { createExtractPipeline } from '../extract/pipeline'
import { buildEpub } from '../epub/build-epub'
import { logPipeline } from '../log'
import { translateArticle as defaultTranslateArticle } from '../translate/openai'
import type {
  ArticleId,
  BuildEpub,
  ClipPipeline,
  ClipResult,
  ExtractPipeline,
  HttpUrl,
  PipelineError,
  PipelineLogContext,
  Result,
  TranslateArticle,
  TranslatedArticle,
} from '../types'
import { err, ok } from '../types'

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

  return async (url, translateDeps, log, hooks) => {
    if (hooks?.resume !== undefined) {
      return finishEpub(url, hooks.resume.id, hooks.resume.article, { fetch: 0, extract: 0, translate: 0 }, build, log)
    }

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
    await hooks?.onTranslated?.({ id: articleId, article: translated.value })
    return finishEpub(
      url,
      articleId,
      translated.value,
      { ...extracted.value.timingsMs, translate: translateMs },
      build,
      log,
    )
  }
}

async function finishEpub(
  url: HttpUrl,
  articleId: ArticleId,
  article: TranslatedArticle,
  timings: { readonly fetch: number; readonly extract: number; readonly translate: number },
  build: BuildEpub,
  log: PipelineLogContext | undefined,
): Promise<Result<ClipResult, PipelineError>> {
  const epubStarted = Date.now()
  try {
    const epub = await build(article)
    const epubMs = Date.now() - epubStarted
    logPipeline({ articleId, stage: 'epub', durationMs: epubMs }, log)
    return ok({
      id: articleId,
      article,
      epub,
      timingsMs: { ...timings, epub: epubMs },
    })
  } catch (cause) {
    const epubMs = Date.now() - epubStarted
    const reason = cause instanceof Error ? cause.message : String(cause)
    logPipeline({ articleId, stage: 'epub', durationMs: epubMs, errorKind: 'epub_failed' }, log)
    return err({
      kind: 'epub_failed',
      url,
      reason: `EPUB generation failed: ${reason}`,
    })
  }
}

export const clipPipeline = createClipPipeline()
