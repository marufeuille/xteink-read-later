import type {
  ExtractedArticle,
  Result,
  TranslateArticle,
  TranslateDeps,
  TranslateFailedError,
  TranslatedArticle,
} from '../types'
import { err, ok } from '../types'
import {
  OPENAI_CHAT_URL,
  OPENAI_MAX_INPUT_CHARS,
  OPENAI_MODEL,
  TRANSLATE_SYSTEM_PROMPT,
} from './constants'

function fail(article: ExtractedArticle, reason: string): Result<TranslatedArticle, TranslateFailedError> {
  return err({ kind: 'translate_failed', extracted: article, reason })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseModelJson(content: string): { title: string; contentHtml: string } | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  if (typeof parsed.title !== 'string' || typeof parsed.contentHtml !== 'string') {
    return null
  }
  const title = parsed.title.trim()
  const contentHtml = parsed.contentHtml.trim()
  if (title.length === 0 || contentHtml.length === 0) {
    return null
  }
  return { title, contentHtml }
}

function choiceContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return null
  }
  const first = payload.choices[0]
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') {
    return null
  }
  return first.message.content
}

export const translateArticle: TranslateArticle = async (
  article,
  deps: TranslateDeps,
): Promise<Result<TranslatedArticle, TranslateFailedError>> => {
  if (article.language === 'ja') {
    return ok({
      ...article,
      language: 'ja',
      translated: false,
    })
  }

  if (deps.OPENAI_API_KEY.trim().length === 0) {
    return fail(article, 'OPENAI_API_KEY is not set')
  }
  if (article.contentHtml.length > OPENAI_MAX_INPUT_CHARS) {
    return fail(article, 'Extracted HTML exceeds the translation size limit')
  }

  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              mode: 'translate',
              sourceLanguage: article.language,
              title: article.title,
              contentHtml: article.contentHtml,
            }),
          },
        ],
      }),
    })

    if (!response.ok) {
      return fail(article, `OpenAI HTTP ${response.status}`)
    }

    const payload: unknown = await response.json()
    const content = choiceContent(payload)
    if (content === null) {
      return fail(article, 'OpenAI response did not include message content')
    }
    const parsed = parseModelJson(content)
    if (parsed === null) {
      return fail(article, 'OpenAI response was not valid title/contentHtml JSON')
    }

    return ok({
      title: parsed.title,
      author: article.author,
      publishedAt: article.publishedAt,
      sourceUrl: article.sourceUrl,
      canonicalUrl: article.canonicalUrl,
      contentHtml: parsed.contentHtml,
      language: 'ja',
      translated: true,
    })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return fail(article, reason)
  }
}
