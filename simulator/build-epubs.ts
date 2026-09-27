import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClipPipeline } from '../src/pipeline/clip'
import { parseHttpUrl, type HttpUrl } from '../src/types'
import { simulatorInputsDir } from './paths'

export type SimulatorExpect = 'image' | 'empty'

export type SimulatorPage = {
  readonly id: string
  readonly htmlFile: string
  readonly url: HttpUrl
  readonly imageFile: string
  readonly imageUrl: HttpUrl
  readonly expect: SimulatorExpect
  readonly turns: number
  readonly bandFrom?: string
}

export type BuiltSimulatorPage = {
  readonly page: SimulatorPage
  readonly epub: Uint8Array
}

type ManifestPage = {
  readonly id?: unknown
  readonly html?: unknown
  readonly url?: unknown
  readonly image?: unknown
  readonly imageUrl?: unknown
  readonly expect?: unknown
  readonly turns?: unknown
  readonly bandFrom?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`simulator manifest ${label} must be a non-empty string`)
  }
  return value
}

function httpUrl(value: string, label: string): HttpUrl {
  const url = parseHttpUrl(value)
  if (url === null) {
    throw new Error(`simulator manifest ${label} is not an http(s) URL: ${value}`)
  }
  return url
}

export function loadSimulatorPages(inputsDir = simulatorInputsDir()): readonly SimulatorPage[] {
  const manifestPath = join(inputsDir, 'manifest.json')
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!isRecord(parsed) || !Array.isArray(parsed.pages)) {
    throw new Error('simulator manifest needs a pages array')
  }
  const pages: SimulatorPage[] = []
  for (const [index, entry] of parsed.pages.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`simulator manifest pages[${index}] is not an object`)
    }
    const raw = entry as ManifestPage
    const expect = requiredString(raw.expect, `pages[${index}].expect`)
    if (expect !== 'image' && expect !== 'empty') {
      throw new Error(`simulator manifest pages[${index}].expect must be image or empty`)
    }
    const htmlFile = requiredString(raw.html, `pages[${index}].html`)
    const imageFile = requiredString(raw.image, `pages[${index}].image`)
    const html = readFileSync(join(inputsDir, htmlFile), 'utf8')
    const imageUrl = httpUrl(requiredString(raw.imageUrl, `pages[${index}].imageUrl`), `pages[${index}].imageUrl`)
    if (!html.includes(imageUrl)) {
      throw new Error(`${htmlFile} does not reference ${imageUrl}`)
    }
    readFileSync(join(inputsDir, imageFile))
    const turns = raw.turns === undefined ? 1 : raw.turns
    if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 0 || turns > 8) {
      throw new Error(`simulator manifest pages[${index}].turns must be an integer from 0 to 8`)
    }
    const bandFrom = typeof raw.bandFrom === 'string' && raw.bandFrom.length > 0 ? raw.bandFrom : undefined
    if (expect === 'image' && bandFrom !== undefined) {
      throw new Error(`${String(raw.id)} is an image page and does not take bandFrom`)
    }
    if (expect === 'empty' && bandFrom === undefined) {
      throw new Error(`${String(raw.id)} needs bandFrom so the empty check uses that page's image band`)
    }
    const page: SimulatorPage = {
      id: requiredString(raw.id, `pages[${index}].id`),
      htmlFile,
      url: httpUrl(requiredString(raw.url, `pages[${index}].url`), `pages[${index}].url`),
      imageFile,
      imageUrl,
      expect,
      turns,
      ...(bandFrom === undefined ? {} : { bandFrom }),
    }
    pages.push(page)
  }
  const ids = new Set<string>()
  const urls = new Set<string>()
  for (const page of pages) {
    if (ids.has(page.id) || urls.has(page.url)) {
      throw new Error(`duplicate simulator page ${page.id}`)
    }
    ids.add(page.id)
    urls.add(page.url)
  }
  for (const page of pages) {
    if (page.bandFrom !== undefined && !pages.some((other) => other.id === page.bandFrom && other.expect === 'image')) {
      throw new Error(`${page.id} bandFrom ${page.bandFrom} is not an image page`)
    }
  }
  if (pages.length === 0) {
    throw new Error('simulator manifest has no pages')
  }
  return pages
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.href
  }
  return input.url
}

function pipelineReason(error: { readonly kind: string; readonly reason?: string }): string {
  return error.reason === undefined ? error.kind : `${error.kind}: ${error.reason}`
}

/** Clip the manifest pages with the existing pipeline. Local files stand in for the image URLs. */
export async function buildSimulatorEpubs(inputsDir = simulatorInputsDir()): Promise<readonly BuiltSimulatorPage[]> {
  const pages = loadSimulatorPages(inputsDir)
  const htmlByUrl = new Map<string, string>()
  const imageByUrl = new Map<string, Uint8Array>()
  for (const page of pages) {
    htmlByUrl.set(page.url, readFileSync(join(inputsDir, page.htmlFile), 'utf8'))
    imageByUrl.set(page.imageUrl, new Uint8Array(readFileSync(join(inputsDir, page.imageFile))))
  }

  const previous = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const html = htmlByUrl.get(url)
    if (html !== undefined) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const image = imageByUrl.get(url)
    if (image !== undefined) {
      return new Response(image, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    throw new Error(`unexpected fetch while building simulator epubs: ${url}`)
  }

  try {
    const pipeline = createClipPipeline()
    const built: BuiltSimulatorPage[] = []
    for (const page of pages) {
      const result = await pipeline(page.url, { OPENAI_API_KEY: 'simulator-pages-are-japanese' })
      if (!result.ok) {
        throw new Error(`${page.id} clip failed: ${pipelineReason(result.error)}`)
      }
      built.push({ page, epub: result.value.epub })
    }
    return built
  } finally {
    globalThis.fetch = previous
  }
}
