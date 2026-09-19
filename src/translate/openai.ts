import type {
  ExtractedArticle,
  Result,
  TranslateArticle,
  TranslateDeps,
  TranslateFailedError,
  TranslatedArticle,
} from '../types'
import { err, ok } from '../types'
import { htmlToMarkdown, markdownToHtml } from '../extract/sanitize-html'
import {
  OPENAI_CHAT_URL,
  OPENAI_MAX_INPUT_CHARS,
  OPENAI_MODEL,
  TRANSLATE_SYSTEM_PROMPT,
  TRANSLATE_TIMEOUT_MS,
} from './constants'

function fail(article: ExtractedArticle, reason: string): Result<TranslatedArticle, TranslateFailedError> {
  return err({ kind: 'translate_failed', extracted: article, reason })
}

function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) ||
    (typeof cause === 'object' &&
      cause !== null &&
      'name' in cause &&
      (cause.name === 'AbortError' || cause.name === 'TimeoutError'))
  )
}

function openaiApiKey(deps: TranslateDeps): string | null {
  const key = deps.OPENAI_API_KEY
  if (typeof key !== 'string') {
    return null
  }
  const trimmed = key.trim()
  return trimmed.length > 0 ? trimmed : null
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError')
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError()
  }
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(resolve, reject)
    })
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapJsonPayload(content: string): string {
  const trimmed = content.trim()
  const lines = trimmed.split('\n')
  const first = lines[0]
  const last = lines[lines.length - 1]
  if (
    lines.length >= 3 &&
    first !== undefined &&
    last !== undefined &&
    /^```(?:json)?\s*$/i.test(first) &&
    /^```\s*$/.test(last)
  ) {
    return lines.slice(1, -1).join('\n').trim()
  }
  return trimmed
}

function parseModelJson(content: string): { title: string; markdown: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapJsonPayload(content))
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  if (typeof parsed.title !== 'string' || typeof parsed.content !== 'string') {
    return null
  }
  const title = parsed.title.trim()
  const markdown = parsed.content.trim()
  if (title.length === 0 || markdown.length === 0) {
    return null
  }
  return { title, markdown }
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

function articleFromMarkdown(
  article: ExtractedArticle,
  title: string,
  markdown: string,
  translated: boolean,
): Result<TranslatedArticle, TranslateFailedError> {
  const contentHtml = markdownToHtml(markdown, article.canonicalUrl)
  if (contentHtml.length === 0) {
    return fail(article, translated ? 'OpenAI response was not valid title/content JSON' : 'Sanitized article was empty')
  }
  return ok({
    title,
    author: article.author,
    publishedAt: article.publishedAt,
    sourceUrl: article.sourceUrl,
    canonicalUrl: article.canonicalUrl,
    contentHtml,
    language: 'ja',
    translated,
  })
}

export const translateArticle: TranslateArticle = async (
  article,
  deps: TranslateDeps,
): Promise<Result<TranslatedArticle, TranslateFailedError>> => {
  const source = htmlToMarkdown(article.contentHtml, article.canonicalUrl)
  if (source.length === 0) {
    return fail(article, 'Sanitized article was empty')
  }

  if (article.language === 'ja') {
    return articleFromMarkdown(article, article.title, source, false)
  }

  const apiKey = openaiApiKey(deps)
  if (apiKey === null) {
    return fail(article, 'OPENAI_API_KEY is not set')
  }
  if (source.length > OPENAI_MAX_INPUT_CHARS) {
    return fail(article, 'Extracted HTML exceeds the translation size limit')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS)
  try {
    const response = await raceAbort(
      fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
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
                content: source,
              }),
            },
          ],
        }),
      }),
      controller.signal,
    )

    if (!response.ok) {
      return fail(article, `OpenAI HTTP ${response.status}`)
    }

    const payload: unknown = await raceAbort(response.json(), controller.signal)
    const content = choiceContent(payload)
    if (content === null) {
      return fail(article, 'OpenAI response did not include message content')
    }
    const parsed = parseModelJson(content)
    if (parsed === null) {
      return fail(article, 'OpenAI response was not valid title/content JSON')
    }

    return articleFromMarkdown(article, article.title, parsed.markdown, true)
  } catch (cause) {
    if (controller.signal.aborted || isAbortError(cause)) {
      return fail(article, 'OpenAI request timed out')
    }
    const reason = cause instanceof Error ? cause.message : String(cause)
    return fail(article, reason)
  } finally {
    clearTimeout(timer)
  }
}
