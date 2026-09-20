import { describe, expect, it } from 'vitest'
import { parseArticleClassification } from '../src/classify/parse'
import { CLASSIFICATION_VERSION } from '../src/classify/taxonomy'

describe('parseArticleClassification', () => {
  it('treats missing or invalid records as skipped uncategorized', () => {
    expect(parseArticleClassification(undefined).status).toBe('skipped')
    expect(parseArticleClassification({ status: 'classified' }).topic).toBe('uncategorized')
    expect(parseArticleClassification({ status: 'weird', topic: 'tech', kind: 'news' }).status).toBe(
      'skipped',
    )
  })

  it('keeps a classified record', () => {
    expect(
      parseArticleClassification({
        version: CLASSIFICATION_VERSION,
        status: 'classified',
        model: 'jev-1.13.0',
        durationMs: 120,
        inputTokens: 400,
        topic: 'tech',
        kind: 'explainer',
        decidedTopic: 'tech',
        decidedKind: 'explainer',
        topicConfidence: 0.9,
        kindConfidence: 0.8,
      }),
    ).toEqual({
      version: CLASSIFICATION_VERSION,
      status: 'classified',
      model: 'jev-1.13.0',
      durationMs: 120,
      inputTokens: 400,
      topic: 'tech',
      kind: 'explainer',
      decidedTopic: 'tech',
      decidedKind: 'explainer',
      topicConfidence: 0.9,
      kindConfidence: 0.8,
      errorCode: null,
    })
  })

  it('repairs classified records that violate the shelf invariant', () => {
    expect(
      parseArticleClassification({
        status: 'classified',
        topic: 'uncategorized',
        kind: 'uncategorized',
        model: 'jev-1.13.0',
        durationMs: 10,
        inputTokens: 1,
        decidedTopic: null,
        decidedKind: null,
        topicConfidence: 0.2,
        kindConfidence: 0.2,
      }),
    ).toMatchObject({
      status: 'low_confidence',
      topic: 'uncategorized',
      kind: 'uncategorized',
      errorCode: null,
    })
    expect(
      parseArticleClassification({
        status: 'classified',
        topic: 'tech',
        kind: 'explainer',
        decidedTopic: 'life',
        decidedKind: 'explainer',
        model: 'jev-1.13.0',
        topicConfidence: 0.9,
        kindConfidence: 0.9,
      }),
    ).toMatchObject({
      status: 'classified',
      topic: 'life',
      kind: 'explainer',
      decidedTopic: 'life',
      decidedKind: 'explainer',
    })
  })

  it('keeps low_confidence and failed records', () => {
    expect(
      parseArticleClassification({
        version: CLASSIFICATION_VERSION,
        status: 'low_confidence',
        model: 'jev-1.13.0',
        durationMs: 40,
        inputTokens: 10,
        topic: 'uncategorized',
        kind: 'news',
        decidedTopic: 'society',
        decidedKind: 'news',
        topicConfidence: 0.4,
        kindConfidence: 0.9,
        errorCode: 'classify_http',
      }),
    ).toMatchObject({
      status: 'low_confidence',
      topic: 'uncategorized',
      kind: 'news',
      decidedTopic: 'society',
      errorCode: null,
    })
    expect(
      parseArticleClassification({
        status: 'failed',
        topic: 'uncategorized',
        kind: 'uncategorized',
        durationMs: 80,
        errorCode: 'classify_timeout',
      }),
    ).toMatchObject({
      status: 'failed',
      topic: 'uncategorized',
      errorCode: 'classify_timeout',
      durationMs: 80,
    })
    expect(
      parseArticleClassification({
        status: 'failed',
        topic: 'uncategorized',
        kind: 'uncategorized',
        errorCode: 'nope',
      }).errorCode,
    ).toBe('classify_internal')
  })
})
