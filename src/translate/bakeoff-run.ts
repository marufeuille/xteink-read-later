import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { htmlToMarkdown } from '../extract/sanitize-html'
import { parseHttpUrl, type HttpUrl } from '../types'
import { loadBakeoffKeys } from './bakeoff-env'
import { BAKEOFF_ARTICLES, type BakeoffArticle } from './bakeoff-corpus'
import { OPENAI_CHAT_URL, TRANSLATE_SYSTEM_PROMPT, TRANSLATE_TIMEOUT_MS } from './constants'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PLAMO_CHAT_URL = 'https://api.platform.preferredai.jp/v1/chat/completions'

const PLAMO_JSON_SCHEMA = {
  name: 'translated_article',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['title', 'content'],
    additionalProperties: false,
  },
} as const

export type BakeoffModelId = 'gpt-4o-mini' | 'gpt-4.1-mini' | 'gpt-5.6-luna' | 'plamo-3.0-prime'

export type BakeoffModel = {
  readonly id: BakeoffModelId
  readonly provider: 'openai' | 'plamo'
  readonly inputUsdPerMillion?: number
  readonly outputUsdPerMillion?: number
  readonly inputJpyPerMillion?: number
  readonly outputJpyPerMillion?: number
}

export const BAKEOFF_MODELS: readonly BakeoffModel[] = [
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    inputUsdPerMillion: 0.15,
    outputUsdPerMillion: 0.6,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    inputUsdPerMillion: 0.4,
    outputUsdPerMillion: 1.6,
  },
  {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.2,
  },
  {
    id: 'plamo-3.0-prime',
    provider: 'plamo',
    inputJpyPerMillion: 60,
    outputJpyPerMillion: 250,
  },
]

export type BakeoffScores = {
  readonly jsonOk: boolean
  readonly keepTokenHits: number
  readonly keepTokenCount: number
  readonly missingKeepTokens: readonly string[]
  readonly headingCount: number
  readonly codeFenceCount: number
  readonly linkCount: number
  readonly sourceHeadingCount: number
  readonly sourceCodeFenceCount: number
  readonly sourceLinkCount: number
  readonly underTimeout: boolean
}

export type BakeoffRunResult = {
  readonly articleId: string
  readonly modelId: BakeoffModelId
  readonly ok: boolean
  readonly durationMs: number
  readonly httpStatus?: number
  readonly reason?: string
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly estimatedUsd?: number
  readonly estimatedJpy?: number
  readonly scores?: BakeoffScores
  readonly title?: string
  readonly contentExcerpt?: string
  readonly content?: string
}

type ChatPayload = {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: unknown }
  }>
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
  }
}

function fixtureBase(article: BakeoffArticle): HttpUrl {
  const parsed = parseHttpUrl(`https://example.com/bakeoff/${article.id}`)
  if (parsed === null) {
    throw new Error(article.id)
  }
  return parsed
}

export function loadBakeoffMarkdown(article: BakeoffArticle): { title: string; markdown: string } {
  const html = readFileSync(join(REPO_ROOT, article.file), 'utf8')
  return { title: article.title, markdown: htmlToMarkdown(html, fixtureBase(article)) }
}

function countHeadings(markdown: string): number {
  return [...markdown.matchAll(/^#{1,3} /gm)].length
}

function countCodeFences(markdown: string): number {
  return [...markdown.matchAll(/```/g)].length
}

function countLinks(markdown: string): number {
  return [...markdown.matchAll(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g)].length
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

function parseTitleContent(content: string): { title: string; content: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapJsonPayload(content))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.title !== 'string' || typeof record.content !== 'string') {
    return null
  }
  const title = record.title.trim()
  const body = record.content.trim()
  if (title.length === 0 || body.length === 0) {
    return null
  }
  return { title, content: body }
}

function scoreOutput(article: BakeoffArticle, source: string, content: string, durationMs: number): BakeoffScores {
  const missingKeepTokens = article.keepTokens.filter((token) => !content.includes(token))
  return {
    jsonOk: true,
    keepTokenHits: article.keepTokens.length - missingKeepTokens.length,
    keepTokenCount: article.keepTokens.length,
    missingKeepTokens,
    headingCount: countHeadings(content),
    codeFenceCount: countCodeFences(content),
    linkCount: countLinks(content),
    sourceHeadingCount: countHeadings(source),
    sourceCodeFenceCount: countCodeFences(source),
    sourceLinkCount: countLinks(source),
    underTimeout: durationMs < TRANSLATE_TIMEOUT_MS,
  }
}

function estimateCost(
  model: BakeoffModel,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
): { estimatedUsd?: number; estimatedJpy?: number } {
  if (promptTokens === undefined || completionTokens === undefined) {
    return {}
  }
  if (model.inputUsdPerMillion !== undefined && model.outputUsdPerMillion !== undefined) {
    return {
      estimatedUsd:
        (promptTokens / 1_000_000) * model.inputUsdPerMillion +
        (completionTokens / 1_000_000) * model.outputUsdPerMillion,
    }
  }
  if (model.inputJpyPerMillion !== undefined && model.outputJpyPerMillion !== undefined) {
    return {
      estimatedJpy:
        (promptTokens / 1_000_000) * model.inputJpyPerMillion +
        (completionTokens / 1_000_000) * model.outputJpyPerMillion,
    }
  }
  return {}
}

function userMessage(title: string, markdown: string): string {
  return JSON.stringify({
    mode: 'translate',
    sourceLanguage: 'non-ja',
    title,
    content: markdown,
  })
}

function openaiBody(model: BakeoffModelId, title: string, markdown: string): string {
  const messages = [
    { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
    { role: 'user', content: userMessage(title, markdown) },
  ]
  if (model === 'gpt-5.6-luna') {
    return JSON.stringify({
      model,
      reasoning_effort: 'none',
      max_completion_tokens: 16_000,
      response_format: { type: 'json_object' },
      messages,
    })
  }
  return JSON.stringify({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages,
  })
}

export function bakeoffChatBody(model: BakeoffModel, title: string, markdown: string): string {
  return model.provider === 'openai' ? openaiBody(model.id, title, markdown) : plamoBody(title, markdown)
}

function plamoBody(title: string, markdown: string): string {
  return JSON.stringify({
    model: 'plamo-3.0-prime',
    temperature: 0.2,
    max_tokens: 16_000,
    reasoning_effort: 'none',
    response_format: { type: 'json_schema', json_schema: PLAMO_JSON_SCHEMA },
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: userMessage(title, markdown) },
    ],
  })
}

async function postChat(
  url: string,
  apiKey: string,
  body: string,
): Promise<{ status: number; payload: unknown; durationMs: number }> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body,
    })
    const payload: unknown = await response.json().catch(() => null)
    return { status: response.status, payload, durationMs: Date.now() - started }
  } catch (cause) {
    const durationMs = Date.now() - started
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw Object.assign(new Error(reason), { durationMs })
  } finally {
    clearTimeout(timer)
  }
}

function choiceContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const chat = payload as ChatPayload
  const content = chat.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : null
}

function usageOf(payload: unknown): { promptTokens?: number; completionTokens?: number } {
  if (typeof payload !== 'object' || payload === null) {
    return {}
  }
  const usage = (payload as ChatPayload).usage
  const promptTokens = usage?.prompt_tokens
  const completionTokens = usage?.completion_tokens
  return {
    ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
    ...(typeof completionTokens === 'number' ? { completionTokens } : {}),
  }
}

export async function runBakeoffModel(
  model: BakeoffModel,
  article: BakeoffArticle,
  keys: { openai: string | null; plamo: string | null },
): Promise<BakeoffRunResult> {
  const { title, markdown } = loadBakeoffMarkdown(article)
  const apiKey = model.provider === 'openai' ? keys.openai : keys.plamo
  if (apiKey === null) {
    return {
      articleId: article.id,
      modelId: model.id,
      ok: false,
      durationMs: 0,
      reason: model.provider === 'openai' ? 'OPENAI_API_KEY is not set' : 'PLAMO_API_KEY is not set',
    }
  }

  const url = model.provider === 'openai' ? OPENAI_CHAT_URL : PLAMO_CHAT_URL
  const body = model.provider === 'openai' ? openaiBody(model.id, title, markdown) : plamoBody(title, markdown)
  try {
    const { status, payload, durationMs } = await postChat(url, apiKey, body)
    if (status < 200 || status >= 300) {
      return {
        articleId: article.id,
        modelId: model.id,
        ok: false,
        durationMs,
        httpStatus: status,
        reason: `HTTP ${status}`,
      }
    }
    const content = choiceContent(payload)
    if (content === null) {
      return {
        articleId: article.id,
        modelId: model.id,
        ok: false,
        durationMs,
        httpStatus: status,
        reason: 'response did not include message content',
      }
    }
    const parsed = parseTitleContent(content)
    if (parsed === null) {
      return {
        articleId: article.id,
        modelId: model.id,
        ok: false,
        durationMs,
        httpStatus: status,
        reason: 'response was not valid title/content JSON',
      }
    }
    const usage = usageOf(payload)
    return {
      articleId: article.id,
      modelId: model.id,
      ok: true,
      durationMs,
      httpStatus: status,
      ...(usage.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
      ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
      ...estimateCost(model, usage.promptTokens, usage.completionTokens),
      scores: scoreOutput(article, markdown, parsed.content, durationMs),
      title: parsed.title,
      contentExcerpt: parsed.content.slice(0, 400),
      content: parsed.content,
    }
  } catch (cause) {
    const durationMs =
      typeof cause === 'object' && cause !== null && 'durationMs' in cause && typeof cause.durationMs === 'number'
        ? cause.durationMs
        : 0
    return {
      articleId: article.id,
      modelId: model.id,
      ok: false,
      durationMs,
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export const BAKEOFF_RUN_COUNT = BAKEOFF_ARTICLES.length * BAKEOFF_MODELS.length

export async function runTranslateBakeoff(): Promise<readonly BakeoffRunResult[]> {
  const keys = loadBakeoffKeys(REPO_ROOT)
  const results: BakeoffRunResult[] = []
  for (const article of BAKEOFF_ARTICLES) {
    for (const model of BAKEOFF_MODELS) {
      results.push(await runBakeoffModel(model, article, keys))
    }
  }
  return results
}
