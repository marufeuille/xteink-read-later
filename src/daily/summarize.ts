import { extractArticle } from '../extract/extract-article'
import { MIN_CONTENT_CHARS } from '../extract/constants'
import { htmlToMarkdown, markdownToHtml, visibleTextLength } from '../extract/sanitize-html'
import { extractCandidateMetadata } from '../candidates/metadata'
import { assertFetchableCandidateUrl } from '../candidates/fetch-policy'
import {
  DIGEST_SUMMARY_MAX_CHARS,
  err,
  ok,
  type CandidateArticle,
  type DigestPreparedItem,
  type DigestSkipReason,
  type FetchPage,
  type Result,
  type TranslateDeps,
} from '../types'
import {
  OPENAI_CHAT_URL,
  OPENAI_MODEL,
  OPENAI_REASONING_EFFORT,
  TRANSLATE_TIMEOUT_MS,
} from '../translate/constants'

const DIGEST_SUMMARY_MAX_INPUT_CHARS = 20_000

export const DIGEST_SUMMARY_SYSTEM_PROMPT = `You write a short Japanese summary of one article for a daily digest EPUB.

The user message is JSON. "content" is compact Markdown from the extracted article body.

Rules:
- Summarize only from "content". Do not invent facts from the title or URL.
- Write natural Japanese Markdown paragraphs. No headings, lists of links, ads, or CTAs.
- Keep code, CLI commands, API names, and proper nouns in the original spelling.
- Stay within the requested character budget.
- Return a JSON object with key "content" only.
- Do not wrap the JSON object in markdown fences.`

export type DigestArticleSkip = {
  readonly reason: DigestSkipReason
}

export type SummarizeDigestArticle = (
  candidate: CandidateArticle,
  deps: TranslateDeps & { readonly fetchPage: FetchPage },
) => Promise<Result<DigestPreparedItem, DigestArticleSkip>>

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

function parseSummaryMarkdown(content: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapJsonPayload(content))
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.content !== 'string') {
    return null
  }
  const markdown = parsed.content.trim()
  return markdown.length > 0 ? markdown : null
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

function skip(reason: DigestSkipReason): Result<DigestPreparedItem, DigestArticleSkip> {
  return err({ reason })
}

async function extractSummarySource(
  candidate: CandidateArticle,
  fetchPage: FetchPage,
): Promise<Result<string, DigestSkipReason>> {
  const fetchable = assertFetchableCandidateUrl(candidate.canonicalUrl)
  if (!fetchable.ok) {
    return err('fetch_failed')
  }
  const page = await fetchPage(candidate.canonicalUrl)
  if (!page.ok) {
    return err('fetch_failed')
  }
  if (extractCandidateMetadata(page.value).paywalled) {
    return err('paywalled')
  }
  const extracted = await extractArticle(page.value)
  if (!extracted.ok || visibleTextLength(extracted.value.contentHtml) < MIN_CONTENT_CHARS) {
    return err('title_only')
  }
  const source = htmlToMarkdown(extracted.value.contentHtml, candidate.canonicalUrl).trim()
  if (source.length === 0) {
    return err('title_only')
  }
  return ok(source)
}

async function requestSummaryMarkdown(
  candidate: CandidateArticle,
  source: string,
  deps: TranslateDeps,
): Promise<string | null> {
  const apiKey = openaiApiKey(deps)
  if (apiKey === null) {
    return null
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
          reasoning_effort: OPENAI_REASONING_EFFORT,
          max_completion_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: DIGEST_SUMMARY_SYSTEM_PROMPT },
            {
              role: 'user',
              content: JSON.stringify({
                mode: 'digest-summary',
                title: candidate.title,
                maxChars: DIGEST_SUMMARY_MAX_CHARS,
                content: source.slice(0, DIGEST_SUMMARY_MAX_INPUT_CHARS),
              }),
            },
          ],
        }),
      }),
      controller.signal,
    )
    if (!response.ok) {
      return null
    }
    const payload: unknown = await raceAbort(response.json(), controller.signal)
    const content = choiceContent(payload)
    return content === null ? null : parseSummaryMarkdown(content)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const summarizeDigestArticle: SummarizeDigestArticle = async (candidate, deps) => {
  const source = await extractSummarySource(candidate, deps.fetchPage)
  if (!source.ok) {
    return skip(source.error)
  }
  const markdown = await requestSummaryMarkdown(candidate, source.value, deps)
  if (markdown === null) {
    return skip('summarize_failed')
  }
  const summaryHtml = markdownToHtml(markdown.slice(0, DIGEST_SUMMARY_MAX_CHARS * 2), candidate.canonicalUrl)
  if (summaryHtml.length === 0) {
    return skip('summarize_failed')
  }
  return ok({
    candidateId: candidate.id,
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    summaryHtml,
  })
}
