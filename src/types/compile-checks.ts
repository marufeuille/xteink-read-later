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
import type { CandidateClipLog, CandidateRecommendLog, FeedScheduleLog, OpdsDownloadLog } from '../log'
import type { ClipPipeline, ClipResult, ExtractPipeline, ExtractResult } from './pipeline'
import type { Result } from './result'
import type { ArticleStore, ArticleWrite } from './store'
import type { JevFailedError } from './jev'
import type { PrRiskBlocker, PrRiskJudgment, PrRiskRoute, PrRiskTrialAction } from './pr-risk'
import {
  DAILY_IDENTITY_STRATEGY,
  DAILY_TIMEZONE,
  type DailyIssueIdentity,
} from './daily'
import { FEED_COLLECT_CRON, FEED_COLLECT_TIMEZONE } from './source'
import {
  RECOMMEND_ERROR_CODES,
  RECOMMEND_GRADES,
  RECOMMEND_STATUSES,
} from './recommend'
import type {
  CandidateRecommendPublic,
  EvaluatedRecommendation,
  LowConfidenceRecommendation,
  RecommendErrorCode,
  RecommendGrade,
  RecommendStatus,
  RecommendVersion,
} from './recommend'
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

type _candidateClipLogHasNoUrl = Assert<'url' extends keyof CandidateClipLog ? false : true>

type _candidateClipLogHasNoBody = Assert<'contentHtml' extends keyof CandidateClipLog ? false : true>

type _opdsDownloadLogHasNoUrl = Assert<'url' extends keyof OpdsDownloadLog ? false : true>

type _opdsDownloadLogHasNoBody = Assert<'contentHtml' extends keyof OpdsDownloadLog ? false : true>

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

type _postCandidateUsesBearer = Assert<
  ApiRoutes['postCandidate']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _postCandidateClipUsesBearer = Assert<
  ApiRoutes['postCandidateClip']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _listCandidatesUsesBearer = Assert<
  ApiRoutes['listCandidates']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _listFeedSourcesUsesBearer = Assert<
  ApiRoutes['listFeedSources']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _postFeedSourceUsesBearer = Assert<
  ApiRoutes['postFeedSource']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _collectFeedSourceUsesBearer = Assert<
  ApiRoutes['collectFeedSource']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>

type _epubFailedIs500 = Assert<Equals<(typeof httpStatusByErrorKind)['epub_failed'], 500>>
type _csrfFailedIs403 = Assert<Equals<(typeof httpStatusByErrorKind)['csrf_failed'], 403>>
type _invalidFeedIs400 = Assert<Equals<(typeof httpStatusByErrorKind)['invalid_feed'], 400>>
type _sourceDisabledIs409 = Assert<Equals<(typeof httpStatusByErrorKind)['source_disabled'], 409>>
type _candidateUnsendableIs409 = Assert<Equals<(typeof httpStatusByErrorKind)['candidate_unsendable'], 409>>

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
    FEED_QUEUE: Queue
    CANDIDATES: D1Database
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

type _recommendVersionPinned = Assert<Equals<RecommendVersion, 'de-recommend-v1'>>
type _recommendStatusesExhaustive = Assert<
  Equals<RecommendStatus, (typeof RECOMMEND_STATUSES)[number]>
>
type _recommendErrorCodesExhaustive = Assert<
  Equals<RecommendErrorCode, (typeof RECOMMEND_ERROR_CODES)[number]>
>
type _recommendGradesExhaustive = Assert<Equals<RecommendGrade, (typeof RECOMMEND_GRADES)[number]>>
type _evaluatedHasVisibleGrade = Assert<Equals<EvaluatedRecommendation['grade'], RecommendGrade>>
type _lowConfidenceHidesGrade = Assert<Equals<LowConfidenceRecommendation['grade'], null>>
type _recommendPublicHasNoConfidence = Assert<
  'confidence' extends keyof CandidateRecommendPublic ? false : true
>
type _postCandidateRecommendUsesBearer = Assert<
  ApiRoutes['postCandidateRecommend']['auth'] extends { readonly scheme: 'bearer' } ? true : false
>
type _candidateRecommendLogHasNoUrl = Assert<'url' extends keyof CandidateRecommendLog ? false : true>
type _candidateRecommendLogHasNoBody = Assert<
  'contentHtml' extends keyof CandidateRecommendLog ? false : true
>

type _dailyStrategyIsNewIdPerDay = Assert<Equals<typeof DAILY_IDENTITY_STRATEGY, 'new-id-per-jst-day'>>
type _dailyTimezoneIsTokyo = Assert<Equals<typeof DAILY_TIMEZONE, 'Asia/Tokyo'>>
type _feedCollectCronIsUtc1900 = Assert<Equals<typeof FEED_COLLECT_CRON, '0 19 * * *'>>
type _feedCollectTimezoneIsTokyo = Assert<Equals<typeof FEED_COLLECT_TIMEZONE, 'Asia/Tokyo'>>
type _feedScheduleLogHasNoUrl = Assert<'url' extends keyof FeedScheduleLog ? false : true>
type _dailyIdentityHasCatalogFields = Assert<
  DailyIssueIdentity extends {
    readonly opdsEntryId: string
    readonly acquisitionUrl: string
    readonly filename: `${DailyIssueIdentity['articleId']}.epub`
    readonly epubIdentifier: string
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
  readonly candidateClipLogHasNoUrl: _candidateClipLogHasNoUrl
  readonly candidateClipLogHasNoBody: _candidateClipLogHasNoBody
  readonly opdsDownloadLogHasNoUrl: _opdsDownloadLogHasNoUrl
  readonly opdsDownloadLogHasNoBody: _opdsDownloadLogHasNoBody
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
  readonly postCandidateUsesBearer: _postCandidateUsesBearer
  readonly postCandidateClipUsesBearer: _postCandidateClipUsesBearer
  readonly listCandidatesUsesBearer: _listCandidatesUsesBearer
  readonly listFeedSourcesUsesBearer: _listFeedSourcesUsesBearer
  readonly postFeedSourceUsesBearer: _postFeedSourceUsesBearer
  readonly collectFeedSourceUsesBearer: _collectFeedSourceUsesBearer
  readonly epubFailedIs500: _epubFailedIs500
  readonly csrfFailedIs403: _csrfFailedIs403
  readonly invalidFeedIs400: _invalidFeedIs400
  readonly sourceDisabledIs409: _sourceDisabledIs409
  readonly candidateUnsendableIs409: _candidateUnsendableIs409
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
  readonly recommendVersionPinned: _recommendVersionPinned
  readonly recommendStatusesExhaustive: _recommendStatusesExhaustive
  readonly recommendErrorCodesExhaustive: _recommendErrorCodesExhaustive
  readonly recommendGradesExhaustive: _recommendGradesExhaustive
  readonly evaluatedHasVisibleGrade: _evaluatedHasVisibleGrade
  readonly lowConfidenceHidesGrade: _lowConfidenceHidesGrade
  readonly recommendPublicHasNoConfidence: _recommendPublicHasNoConfidence
  readonly postCandidateRecommendUsesBearer: _postCandidateRecommendUsesBearer
  readonly candidateRecommendLogHasNoUrl: _candidateRecommendLogHasNoUrl
  readonly candidateRecommendLogHasNoBody: _candidateRecommendLogHasNoBody
  readonly dailyStrategyIsNewIdPerDay: _dailyStrategyIsNewIdPerDay
  readonly dailyTimezoneIsTokyo: _dailyTimezoneIsTokyo
  readonly dailyIdentityHasCatalogFields: _dailyIdentityHasCatalogFields
  readonly feedCollectCronIsUtc1900: _feedCollectCronIsUtc1900
  readonly feedCollectTimezoneIsTokyo: _feedCollectTimezoneIsTokyo
  readonly feedScheduleLogHasNoUrl: _feedScheduleLogHasNoUrl
}
