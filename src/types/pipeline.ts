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
import type { Result } from './result'

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
) => Promise<Result<TranslatedArticle, TranslateFailedError>>

export type BuildEpub = (article: TranslatedArticle) => Promise<EpubBytes>

export type ParseClipUrl = (
  body: ClipRequestBody,
) => Result<HttpUrl, InvalidUrlError>

export type ExtractPipeline = (
  url: HttpUrl,
) => Promise<Result<ExtractResult, ExtractError>>

export type ClipPipeline = (
  url: HttpUrl,
  deps: TranslateDeps,
) => Promise<Result<ClipResult, PipelineError>>
