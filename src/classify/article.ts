import { htmlToMarkdown } from '../extract/sanitize-html'
import { evaluateSystemOne as defaultEvaluateSystemOne, openRouterApiKey } from '../jev/client'
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  ClassifyArticle,
  ClassifyErrorCode,
  JevErrorCode,
  SystemOneAnswer,
  TranslatedArticle,
} from '../types'
import {
  ARTICLE_KIND_CRITERIA,
  ARTICLE_TOPIC_CRITERIA,
  attemptedClassification,
  CLASSIFY_MAX_EXCERPT_CHARS,
  CLASSIFY_MAX_HTML_CHARS,
  isDecidedKind,
  isDecidedTopic,
  unavailableClassification,
} from './taxonomy'

const CLASSIFY_ERROR_CODE_BY_JEV: Record<JevErrorCode, ClassifyErrorCode> = {
  http: 'classify_http',
  timeout: 'classify_timeout',
  invalid_payload: 'classify_invalid_payload',
  missing_key: 'classify_internal',
  network: 'classify_internal',
}

const CLASSIFY_QUESTIONS: Readonly<Record<'topic' | 'kind', ChoiceQuestion>> = {
  topic: {
    type: 'choice',
    instructions:
      '`title` と `excerpt` から、この記事の主な話題を1つ選ぶ。複数の話題があっても、読む人が探すときに使う中心の棚にする。`criteria` のキーだけを choice に返す。',
    criteria: ARTICLE_TOPIC_CRITERIA,
  },
  kind: {
    type: 'choice',
    instructions:
      '`title` と `excerpt` から、この記事の種類を1つ選ぶ。話題ではなく書き方・体裁で決める。`criteria` のキーだけを choice に返す。',
    criteria: ARTICLE_KIND_CRITERIA,
  },
}

function excerptFor(article: TranslatedArticle): string {
  return htmlToMarkdown(article.contentHtml.slice(0, CLASSIFY_MAX_HTML_CHARS), article.canonicalUrl)
    .trim()
    .slice(0, CLASSIFY_MAX_EXCERPT_CHARS)
}

function choiceAnswer(
  answers: Readonly<Record<string, SystemOneAnswer>>,
  key: 'topic' | 'kind',
): ChoiceAnswer | null {
  const answer = answers[key]
  return answer?.type === 'choice' ? answer : null
}

export const classifyArticle: ClassifyArticle = async (
  article,
  deps,
  evaluate = defaultEvaluateSystemOne,
) => {
  if (openRouterApiKey(deps) === null) {
    return unavailableClassification('skipped')
  }

  const started = Date.now()
  const result = await evaluate(
    {
      state: {
        title: article.title,
        author: article.author,
        canonicalUrl: article.canonicalUrl,
        excerpt: excerptFor(article),
      },
      questions: CLASSIFY_QUESTIONS,
    },
    deps,
  )
  const durationMs = Date.now() - started
  if (!result.ok) {
    return unavailableClassification('failed', durationMs, CLASSIFY_ERROR_CODE_BY_JEV[result.error.code])
  }

  const topicAnswer = choiceAnswer(result.value.answers, 'topic')
  const kindAnswer = choiceAnswer(result.value.answers, 'kind')
  if (topicAnswer === null || kindAnswer === null) {
    return unavailableClassification('failed', durationMs, 'classify_invalid_payload')
  }

  const decidedTopic = isDecidedTopic(topicAnswer.choice) ? topicAnswer.choice : null
  const decidedKind = isDecidedKind(kindAnswer.choice) ? kindAnswer.choice : null
  return attemptedClassification({
    model: result.value.model,
    durationMs,
    inputTokens: result.value.usage.inputTokens,
    decidedTopic,
    decidedKind,
    topicConfidence: topicAnswer.confidence,
    kindConfidence: kindAnswer.confidence,
  })
}
