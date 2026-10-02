import type { SummarizeDigestArticle } from './summarize'
import type { DigestRunStore } from './run-store'
import type {
  ArticleStore,
  CandidateStore,
  CreateArticleStore,
  CreateCandidateStore,
  CreateDigestStore,
  DigestStore,
  EvaluateSystemOne,
  FetchPage,
} from '../types'

export type RunDailyDigestDeps = {
  readonly date?: string
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly candidateStore?: CandidateStore
  readonly createCandidateStore?: CreateCandidateStore
  readonly digestStore?: DigestStore
  readonly createDigestStore?: CreateDigestStore
  readonly fetchPage: FetchPage
  readonly summarize?: SummarizeDigestArticle
  readonly evaluateRecommend?: EvaluateSystemOne
  readonly now?: () => Date
  readonly maxJevCalls?: number
  readonly runStore?: DigestRunStore
}
