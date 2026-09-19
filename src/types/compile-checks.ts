import type {
  ArticleMeta,
  ExtractedArticle,
  ExtractedContent,
  TranslatedArticle,
} from './article'
import type {
  ErrorKind,
  ExtractError,
  httpStatusByErrorKind,
  HttpStatusOf,
  PipelineError,
} from './errors'
import type {
  ApiRoutes,
  ClipExtractBody,
  ClipReadyBody,
  ClipTranslatedBody,
  ErrorBody,
  TranslateFailedBody,
} from './http'
import {
  articleEpubKey,
  articleMetaKey,
  type ArticleId,
  type ArticleObjectKey,
} from './id'
import type { ClipPipeline, ClipResult, ExtractPipeline, ExtractResult } from './pipeline'
import type { Result } from './result'
import type { ArticleStore } from './store'

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type Assert<T extends true> = T

type IsPromiseResult<T, V, E> = T extends Promise<Result<V, E>> ? true : false

type _languageIsBinary = Assert<
  Equals<ExtractedArticle['language'], 'ja' | 'non-ja'>
>

type _storedLanguageIsJa = Assert<Equals<ArticleMeta['language'], 'ja'>>

type _translatedLanguageIsJa = Assert<
  Equals<TranslatedArticle['language'], 'ja'>
>

type _extractedContentHasNoLanguage = Assert<
  'language' extends keyof ExtractedContent ? false : true
>

type _metaKeepsIdentity = Assert<Equals<ArticleMeta['id'], ArticleId>>

type _extractBodyHasHtml = Assert<
  ClipExtractBody extends { readonly contentHtml: string } ? true : false
>

type _translatedBodyHasHtmlAndFlag = Assert<
  ClipTranslatedBody extends {
    readonly contentHtml: string
    readonly translated: boolean
    readonly language: 'ja'
  }
    ? true
    : false
>

type _readyBodyHasEpubPath = Assert<
  ClipReadyBody['epubPath'] extends `/articles/${ArticleId}/book.epub`
    ? true
    : false
>

type _readyBodyHasNoHtml = Assert<
  'contentHtml' extends keyof ClipReadyBody ? false : true
>

type _readyBodyHasNoCreatedAt = Assert<
  'createdAt' extends keyof ClipReadyBody ? false : true
>

type _translateFailureKeepsExtracted = Assert<
  TranslateFailedBody['error']['extracted'] extends ExtractedArticle ? true : false
>

type _statusMapCoversPipeline = Assert<
  PipelineError['kind'] extends keyof typeof httpStatusByErrorKind ? true : false
>

type ErrorStatusByCode = {
  [K in ErrorKind]: Extract<ErrorBody, { error: { code: K } }>['error']['status'] extends HttpStatusOf<K>
    ? true
    : false
}

type _errorBodyStatusMatchesCode = Assert<Equals<ErrorStatusByCode[ErrorKind], true>>

type _clipUsesBearer = Assert<
  ApiRoutes['clip']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _opdsUsesBasic = Assert<
  ApiRoutes['opdsCatalog']['auth'] extends { readonly scheme: 'basic' }
    ? true
    : false
>

type _opdsDownloadUsesBasic = Assert<
  ApiRoutes['opdsDownload']['auth'] extends { readonly scheme: 'basic' }
    ? true
    : false
>

type _storeDeleteReturnsBoolean = Assert<
  ReturnType<ArticleStore['delete']> extends Promise<boolean> ? true : false
>

type _pipelinesReturnResults = Assert<
  Equals<
    [
      IsPromiseResult<ReturnType<ExtractPipeline>, ExtractResult, ExtractError>,
      IsPromiseResult<ReturnType<ClipPipeline>, ClipResult, PipelineError>,
    ],
    [true, true]
  >
>

type _keysAreObjectKeys = Assert<
  Equals<
    [
      ReturnType<typeof articleMetaKey> extends ArticleObjectKey ? true : false,
      ReturnType<typeof articleEpubKey> extends ArticleObjectKey ? true : false,
    ],
    [true, true]
  >
>

type _envHasSecretsAndBucket = Assert<
  Cloudflare.Env extends {
    ARTICLES: R2Bucket
    OPENAI_API_KEY: string
    CLIP_TOKEN: string
    OPDS_USERNAME: string
    OPDS_PASSWORD: string
  }
    ? true
    : false
>

export type CompileChecks = {
  readonly languageIsBinary: _languageIsBinary
  readonly storedLanguageIsJa: _storedLanguageIsJa
  readonly translatedLanguageIsJa: _translatedLanguageIsJa
  readonly extractedContentHasNoLanguage: _extractedContentHasNoLanguage
  readonly metaKeepsIdentity: _metaKeepsIdentity
  readonly extractBodyHasHtml: _extractBodyHasHtml
  readonly translatedBodyHasHtmlAndFlag: _translatedBodyHasHtmlAndFlag
  readonly readyBodyHasEpubPath: _readyBodyHasEpubPath
  readonly readyBodyHasNoHtml: _readyBodyHasNoHtml
  readonly readyBodyHasNoCreatedAt: _readyBodyHasNoCreatedAt
  readonly translateFailureKeepsExtracted: _translateFailureKeepsExtracted
  readonly statusMapCoversPipeline: _statusMapCoversPipeline
  readonly errorBodyStatusMatchesCode: _errorBodyStatusMatchesCode
  readonly clipUsesBearer: _clipUsesBearer
  readonly opdsUsesBasic: _opdsUsesBasic
  readonly opdsDownloadUsesBasic: _opdsDownloadUsesBasic
  readonly storeDeleteReturnsBoolean: _storeDeleteReturnsBoolean
  readonly pipelinesReturnResults: _pipelinesReturnResults
  readonly keysAreObjectKeys: _keysAreObjectKeys
  readonly envHasSecretsAndBucket: _envHasSecretsAndBucket
}
