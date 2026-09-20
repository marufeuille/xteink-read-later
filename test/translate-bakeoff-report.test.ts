import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyBakeoffDotEnv, loadBakeoffKeys, parseDotEnv } from '../src/translate/bakeoff-env'
import { comparableUsd, formatBakeoffSummary, writeBakeoffArtifacts } from '../src/translate/bakeoff-report'
import { BAKEOFF_MODELS, bakeoffChatBody, japaneseCharRatio, UNTRANSLATED_JA_RATIO, type BakeoffRunResult } from '../src/translate/bakeoff-run'

describe('translate bakeoff env', () => {
  it('parses quoted .dev.vars lines and ignores comments', () => {
    const parsed = parseDotEnv(`
# comment
OPENAI_API_KEY="sk-test"
export PLAMO_API_KEY='plamo-test'
EMPTY=
`)
    expect(parsed.OPENAI_API_KEY).toBe('sk-test')
    expect(parsed.PLAMO_API_KEY).toBe('plamo-test')
    expect(parsed.EMPTY).toBe('')
  })

  it('fills only missing bakeoff keys and does not override the shell', () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'from-shell' }
    applyBakeoffDotEnv(
      { OPENAI_API_KEY: 'from-file', PLAMO_API_KEY: 'plamo-file', CLIP_TOKEN: 'ignored' },
      env,
    )
    expect(env.OPENAI_API_KEY).toBe('from-shell')
    expect(env.PLAMO_API_KEY).toBe('plamo-file')
    expect(env.CLIP_TOKEN).toBeUndefined()
  })

  it('loads keys from a repo-root .dev.vars when process env is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'bakeoff-env-'))
    writeFileSync(join(root, '.dev.vars'), 'OPENAI_API_KEY=sk-from-dev\nPLAMO_API_KEY=plamo-from-dev\n')
    const env: Record<string, string | undefined> = {}
    expect(loadBakeoffKeys(root, env)).toEqual({ openai: 'sk-from-dev', plamo: 'plamo-from-dev' })
  })
})

describe('translate bakeoff report', () => {
  const sample: BakeoffRunResult[] = [
    {
      articleId: 'hedging-prose',
      modelId: 'gpt-4.1-mini',
      ok: true,
      durationMs: 2100,
      promptTokens: 1000,
      completionTokens: 500,
      estimatedUsd: 0.0012,
      scores: {
        jsonOk: true,
        keepTokenHits: 4,
        keepTokenCount: 4,
        missingKeepTokens: [],
        headingCount: 3,
        codeFenceCount: 2,
        linkCount: 1,
        sourceHeadingCount: 3,
        sourceCodeFenceCount: 2,
        sourceLinkCount: 1,
        underTimeout: true,
        japaneseCharRatio: 0.42,
        looksUntranslated: false,
      },
      title: 'ほぼ正しい翻訳',
      contentExcerpt: '短い抜粋',
      content: '本文です。',
    },
    {
      articleId: 'hedging-prose',
      modelId: 'plamo-3.0-prime',
      ok: true,
      durationMs: 3400,
      promptTokens: 1100,
      completionTokens: 600,
      estimatedJpy: 0.216,
      scores: {
        jsonOk: true,
        keepTokenHits: 3,
        keepTokenCount: 4,
        missingKeepTokens: ['gpt-4o-mini'],
        headingCount: 3,
        codeFenceCount: 2,
        linkCount: 1,
        sourceHeadingCount: 3,
        sourceCodeFenceCount: 2,
        sourceLinkCount: 1,
        underTimeout: true,
        japaneseCharRatio: 0.42,
        looksUntranslated: false,
      },
      title: 'ほぼ正しい翻訳',
      contentExcerpt: '別の抜粋',
      content: '別本文。',
    },
  ]

  it('summarizes speed, cost, and where to read naturalness', () => {
    const summary = formatBakeoffSummary(sample)
    expect(summary).toContain('## 速度')
    expect(summary).toContain('## コスト')
    expect(summary).toContain('## 自然さ')
    expect(summary).toContain('gpt-4.1-mini')
    expect(summary).toContain('plamo-3.0-prime')
    expect(summary).toContain('$0.0012')
    expect(summary).toContain('¥0.22')
    expect(summary).toContain('gpt-4o-mini')
    expect(summary).toContain('42%')
    expect(summary).not.toContain('sk-')
  })

  it('converts PLaMo yen to comparable USD', () => {
    const plamo = sample[1]
    expect(plamo).toBeDefined()
    if (plamo === undefined) {
      return
    }
    expect(comparableUsd(plamo)).toBeCloseTo(0.216 / 150)
  })

  it('writes full translations for naturalness review', () => {
    const root = mkdtempSync(join(tmpdir(), 'bakeoff-report-'))
    writeBakeoffArtifacts(root, sample)
    expect(readFileSync(join(root, 'tmp/translate-bakeoff/hedging-prose/gpt-4.1-mini.md'), 'utf8')).toContain(
      '本文です。',
    )
    const json = readFileSync(join(root, 'tmp/translate-bakeoff/results.json'), 'utf8')
    expect(json).not.toContain('"content":')
    expect(json).toContain('contentExcerpt')
  })
})

describe('translate bakeoff request bodies', () => {
  it('omits temperature on gpt-5.6-luna and raises max_completion_tokens', () => {
    const luna = BAKEOFF_MODELS.find((model) => model.id === 'gpt-5.6-luna')
    const mini = BAKEOFF_MODELS.find((model) => model.id === 'gpt-4.1-mini')
    expect(luna).toBeDefined()
    expect(mini).toBeDefined()
    if (luna === undefined || mini === undefined) {
      return
    }
    const lunaBody = JSON.parse(bakeoffChatBody(luna, 't', 'c')) as Record<string, unknown>
    const miniBody = JSON.parse(bakeoffChatBody(mini, 't', 'c')) as Record<string, unknown>
    expect(lunaBody.temperature).toBeUndefined()
    expect(lunaBody.reasoning_effort).toBe('none')
    expect(lunaBody.max_completion_tokens).toBe(16_000)
    expect(miniBody.temperature).toBe(0.2)
  })

  it('asks PLaMo in Japanese and does not send echoable title/content JSON', () => {
    const plamo = BAKEOFF_MODELS.find((model) => model.id === 'plamo-3.0-prime')
    expect(plamo).toBeDefined()
    if (plamo === undefined) {
      return
    }
    const body = JSON.parse(bakeoffChatBody(plamo, 'Keep compatibility_date current', '# Hello\n\nWorld')) as {
      messages: ReadonlyArray<{ role: string; content: string }>
      response_format: { json_schema: { description?: string; schema: { properties: Record<string, { description?: string }> } } }
    }
    const system = body.messages.find((message) => message.role === 'system')?.content ?? ''
    const user = body.messages.find((message) => message.role === 'user')?.content ?? ''
    expect(system).toContain('自然な日本語')
    expect(user).toContain('全文翻訳')
    expect(user).toContain('# Hello')
    expect(user).not.toContain('"mode":"translate"')
    expect(user).not.toContain('"content":')
    expect(body.response_format.json_schema.description).toContain('日本語')
    expect(body.response_format.json_schema.schema.properties.content?.description).toContain('日本語')
  })
})

describe('translate bakeoff japanese ratio', () => {
  it('treats copied English markdown as untranslated', () => {
    expect(japaneseCharRatio('Keep compatibility_date current. Use wrangler.jsonc.')).toBe(0)
    expect(japaneseCharRatio('小さなモデルは技術的には正しくても、読んでいて気持ちが悪い日本語を出す。')).toBeGreaterThan(0.8)
    expect(japaneseCharRatio('互換性日付を compatibility_date のまま保つ。')).toBeGreaterThan(UNTRANSLATED_JA_RATIO)
  })
})
