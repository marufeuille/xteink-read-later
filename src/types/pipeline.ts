import type {
  ExtractedArticle,
  ExtractedContent,
  FetchedPage,
  Language,
  TranslatedArticle,
} from './article'
import type {
  ExtractError,
  ExtractFailedError,
  FetchError,
  InvalidUrlError,
  PipelineError,
  TranslateFailedError,
} from './errors'
import type { ClipExtractTimingsMs, ClipRequestBody, ClipTimingsMs } from './http'
import type { ArticleId, EpubBytes, HttpUrl } from './id'
import type { PipelineLogContext } from './job'
import type { Result } from './result'

/** OpenAI Chat Completions counts. Zeros mean the call was not made or usage was unusable. */
export type OpenAiTokenUsage = {
  readonly promptTokens: number
  readonly completionTokens: number
}

export type TranslateDeps = Pick<Cloudflare.Env, 'OPENAI_API_KEY'>

export type ExtractResult = {
  readonly id: ArticleId
  readonly article: ExtractedArticle
  readonly timingsMs: ClipExtractTimingsMs
}

export type ClipResult = {
  readonly id: ArticleId
  readonly article: TranslatedArticle
  readonly epub: EpubBytes
  readonly timingsMs: ClipTimingsMs
}

export type FetchPage = (
  url: HttpUrl,
) => Promise<Result<FetchedPage, FetchError>>

export type ExtractArticle = (
  page: FetchedPage,
) => Promise<Result<ExtractedContent, ExtractFailedError>>

export type DetectLanguage = (input: {
  readonly htmlLang: string | null
  readonly contentHtml: string
}) => Language

export type AssignLanguage = (
  content: ExtractedContent,
  language: Language,
) => ExtractedArticle

export type TranslateArticle = (
  article: ExtractedArticle,
  deps: TranslateDeps,
) => Promise<Result<TranslatedArticle, TranslateFailedError> & { readonly usage: OpenAiTokenUsage }>

export type BuildEpub = (
  article: TranslatedArticle,
  options?: {
    readonly identifier?: string
    readonly images?: readonly {
      readonly id: string
      readonly href: string
      readonly bytes: Uint8Array
    }[]
  },
) => Promise<EpubBytes>

export type ParseClipUrl = (
  body: ClipRequestBody,
) => Result<HttpUrl, InvalidUrlError>

export type ExtractPipeline = (
  url: HttpUrl,
  log?: PipelineLogContext,
) => Promise<Result<ExtractResult, ExtractError>>

export type ClipResume = {
  readonly id: ArticleId
  readonly article: TranslatedArticle
}

export type ClipPipelineHooks = {
  readonly resume?: ClipResume
  readonly onTranslated?: (resume: ClipResume) => Promise<void>
}

export type ClipPipeline = (
  url: HttpUrl,
  deps: TranslateDeps,
  log?: PipelineLogContext,
  hooks?: ClipPipelineHooks,
) => Promise<Result<ClipResult, PipelineError> & { readonly usage: OpenAiTokenUsage }>
