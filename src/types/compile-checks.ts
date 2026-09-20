import type {
  ArticleMeta,
  ExtractedArticle,
  ExtractedContent,
  TranslatedArticle,
} from './article'
import type {
  ArticleClassification,
  ClassificationStatus,
  ClassificationVersion,
  ClassifiedClassification,
  ClassifyArticle,
  ClassifyErrorCode,
  FailedClassification,
  SkippedClassification,
} from './classify'
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
  ClipJobFailedBody,
  ClipQueuedBody,
  ClipReadyBody,
  ClipTimingsMs,
  ClipTranslatedBody,
  ErrorBody,
  PIPELINE_STAGES,
  PipelineLog,
  PurchasedBookBody,
  TranslateFailedBody,
} from './http'
import {
  articleEpubKey,
  articleMetaKey,
  clipJobKey,
  type ArticleId,
  type ArticleObjectKey,
  type ClipJobId,
  type ClipJobKey,
} from './id'
import type { ClipQueueMessage } from './job'
import type { ClipPipeline, ClipResult, ExtractPipeline, ExtractResult } from './pipeline'
import type { Result } from './result'
import type { ArticleStore, ArticleWrite } from './store'
import type { JevFailedError } from './jev'
import type { PrRiskBlocker, PrRiskJudgment, PrRiskRoute, PrRiskTrialAction } from './pr-risk'
import { CLASSIFICATION_STATUSES, CLASSIFY_ERROR_CODES } from '../classify/taxonomy'

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

type _metaHasClassification = Assert<Equals<ArticleMeta['classification'], ArticleClassification>>

type _articleWriteClassificationOptional = Assert<
  Equals<ArticleWrite['classification'], ArticleClassification | undefined>
>

type _classifiedHasDecidedShelves = Assert<
  Equals<
    [
      ClassifiedClassification['topic'],
      ClassifiedClassification['kind'],
      ClassifiedClassification['errorCode'],
      ClassifiedClassification['model'],
      ClassifiedClassification['version'],
    ],
    [
      ClassifiedClassification['decidedTopic'],
      ClassifiedClassification['decidedKind'],
      null,
      string,
      ClassificationVersion,
    ]
  >
>

type _skippedIsUnavailable = Assert<
  Equals<
    [SkippedClassification['topic'], SkippedClassification['kind'], SkippedClassification['errorCode']],
    ['uncategorized', 'uncategorized', null]
  >
>

type _failedHasErrorCode = Assert<Equals<FailedClassification['errorCode'], ClassifyErrorCode>>

type _jevFailedIsNotHttpError = Assert<JevFailedError['kind'] extends ErrorKind ? false : true>

type _classifyErrorCodesExhaustive = Assert<
  Equals<(typeof CLASSIFY_ERROR_CODES)[number], ClassifyErrorCode>
>

type _classificationStatusesExhaustive = Assert<
  Equals<(typeof CLASSIFICATION_STATUSES)[number], ClassificationStatus>
>

type _classifyArticleIsTotal = Assert<
  Equals<
    [
      ReturnType<ClassifyArticle> extends Promise<ArticleClassification> ? true : false,
      ReturnType<ClassifyArticle> extends Promise<Result<unknown, unknown>> ? true : false,
    ],
    [true, false]
  >
>

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

type _purchasedBookHasNoHtml = Assert<
  'contentHtml' extends keyof PurchasedBookBody ? false : true
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

type _clipJobUsesBearer = Assert<
  ApiRoutes['getClipJob']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _clipSuccessIsQueued = Assert<Equals<ApiRoutes['clip']['success'], ClipQueuedBody>>

type _queuedBodyHasNoTitle = Assert<'title' extends keyof ClipQueuedBody ? false : true>

type _queuedBodyHasNoExtracted = Assert<'extracted' extends keyof ClipQueuedBody ? false : true>

type _failedJobHasNoExtracted = Assert<
  'extracted' extends keyof ClipJobFailedBody['error'] ? false : true
>

type _queueMessageKeys = Assert<Equals<keyof ClipQueueMessage, 'jobId' | 'runId' | 'url'>>

type _pipelineLogHasNoUrl = Assert<'url' extends keyof PipelineLog ? false : true>

type _pipelineLogHasNoExtracted = Assert<'extracted' extends keyof PipelineLog ? false : true>

type _pipelineLogHasNoJobId = Assert<'jobId' extends keyof PipelineLog ? false : true>

type PipelineStage = (typeof PIPELINE_STAGES)[number]

type _pipelineLogStageMatches = Assert<Equals<PipelineLog['stage'], PipelineStage>>

type _timingStagesMatchLog = Assert<
  Equals<keyof ClipTimingsMs, Exclude<PipelineStage, 'store' | 'queue' | 'classify'>>
>

type _pipelineLogClassifyErrorIsNotHttp = Assert<
  ClassifyErrorCode extends NonNullable<PipelineLog['errorKind']> ? true : false
>

type _storeCanUpdateClassification = Assert<
  Equals<Parameters<ArticleStore['putClassification']>[1], ArticleClassification>
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

type _getArticleUsesBasic = Assert<
  ApiRoutes['getArticle']['auth'] extends { readonly scheme: 'basic' } ? true : false
>

type _getArticleEpubUsesBasic = Assert<
  ApiRoutes['getArticleEpub']['auth'] extends { readonly scheme: 'basic' }
    ? true
    : false
>

type _purchasedBookUsesBearer = Assert<
  ApiRoutes['postPurchasedBook']['auth'] extends { readonly scheme: 'bearer' }
    ? true
    : false
>

type _epubFailedIs500 = Assert<Equals<(typeof httpStatusByErrorKind)['epub_failed'], 500>>

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
      ReturnType<typeof clipJobKey> extends ClipJobKey ? true : false,
    ],
    [true, true, true]
  >
>

type _jobKeyPrefix = Assert<
  ReturnType<typeof clipJobKey> extends `jobs/${ClipJobId}.json` ? true : false
>

type _envHasSecretsAndBucket = Assert<
  Cloudflare.Env extends {
    ARTICLES: R2Bucket
    CLIP_QUEUE: Queue
    OPENAI_API_KEY: string
    OPENROUTER_API_KEY: string
    CLIP_TOKEN: string
    OPDS_USERNAME: string
    OPDS_PASSWORD: string
  }
    ? true
    : false
>

type _prRiskTrialIsRecordOnly = Assert<Equals<PrRiskJudgment['trialAction'], PrRiskTrialAction>>
type _prRiskTrialActionLiteral = Assert<Equals<PrRiskTrialAction, 'record_only'>>
type _prRiskRouteHasNoMerge = Assert<Equals<PrRiskRoute, 'additional_review' | 'low_risk'>>
type _prRiskBlockers = Assert<
  Equals<
    PrRiskBlocker,
    | 'incomplete_input'
    | 'hard_rule'
    | 'jev_skipped'
    | 'jev_failed'
    | 'low_confidence'
    | 'jev_high'
    | 'noul_high'
  >
>
type _prRiskRuleVersionPinned = Assert<Equals<PrRiskJudgment['ruleVersion'], 'pr-risk-v1'>>

export type CompileChecks = {
  readonly languageIsBinary: _languageIsBinary
  readonly storedLanguageIsJa: _storedLanguageIsJa
  readonly translatedLanguageIsJa: _translatedLanguageIsJa
  readonly extractedContentHasNoLanguage: _extractedContentHasNoLanguage
  readonly metaKeepsIdentity: _metaKeepsIdentity
  readonly metaHasClassification: _metaHasClassification
  readonly articleWriteClassificationOptional: _articleWriteClassificationOptional
  readonly classifiedHasDecidedShelves: _classifiedHasDecidedShelves
  readonly skippedIsUnavailable: _skippedIsUnavailable
  readonly failedHasErrorCode: _failedHasErrorCode
  readonly jevFailedIsNotHttpError: _jevFailedIsNotHttpError
  readonly classifyErrorCodesExhaustive: _classifyErrorCodesExhaustive
  readonly classificationStatusesExhaustive: _classificationStatusesExhaustive
  readonly classifyArticleIsTotal: _classifyArticleIsTotal
  readonly extractBodyHasHtml: _extractBodyHasHtml
  readonly translatedBodyHasHtmlAndFlag: _translatedBodyHasHtmlAndFlag
  readonly readyBodyHasEpubPath: _readyBodyHasEpubPath
  readonly readyBodyHasNoHtml: _readyBodyHasNoHtml
  readonly readyBodyHasNoCreatedAt: _readyBodyHasNoCreatedAt
  readonly purchasedBookHasNoHtml: _purchasedBookHasNoHtml
  readonly translateFailureKeepsExtracted: _translateFailureKeepsExtracted
  readonly statusMapCoversPipeline: _statusMapCoversPipeline
  readonly errorBodyStatusMatchesCode: _errorBodyStatusMatchesCode
  readonly clipUsesBearer: _clipUsesBearer
  readonly clipJobUsesBearer: _clipJobUsesBearer
  readonly clipSuccessIsQueued: _clipSuccessIsQueued
  readonly queuedBodyHasNoTitle: _queuedBodyHasNoTitle
  readonly queuedBodyHasNoExtracted: _queuedBodyHasNoExtracted
  readonly failedJobHasNoExtracted: _failedJobHasNoExtracted
  readonly queueMessageKeys: _queueMessageKeys
  readonly pipelineLogHasNoUrl: _pipelineLogHasNoUrl
  readonly pipelineLogHasNoExtracted: _pipelineLogHasNoExtracted
  readonly pipelineLogHasNoJobId: _pipelineLogHasNoJobId
  readonly pipelineLogStageMatches: _pipelineLogStageMatches
  readonly timingStagesMatchLog: _timingStagesMatchLog
  readonly pipelineLogClassifyErrorIsNotHttp: _pipelineLogClassifyErrorIsNotHttp
  readonly storeCanUpdateClassification: _storeCanUpdateClassification
  readonly opdsUsesBasic: _opdsUsesBasic
  readonly opdsDownloadUsesBasic: _opdsDownloadUsesBasic
  readonly getArticleUsesBasic: _getArticleUsesBasic
  readonly getArticleEpubUsesBasic: _getArticleEpubUsesBasic
  readonly purchasedBookUsesBearer: _purchasedBookUsesBearer
  readonly epubFailedIs500: _epubFailedIs500
  readonly storeDeleteReturnsBoolean: _storeDeleteReturnsBoolean
  readonly pipelinesReturnResults: _pipelinesReturnResults
  readonly keysAreObjectKeys: _keysAreObjectKeys
  readonly jobKeyPrefix: _jobKeyPrefix
  readonly envHasSecretsAndBucket: _envHasSecretsAndBucket
  readonly prRiskTrialIsRecordOnly: _prRiskTrialIsRecordOnly
  readonly prRiskTrialActionLiteral: _prRiskTrialActionLiteral
  readonly prRiskRouteHasNoMerge: _prRiskRouteHasNoMerge
  readonly prRiskBlockers: _prRiskBlockers
  readonly prRiskRuleVersionPinned: _prRiskRuleVersionPinned
}
