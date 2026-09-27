import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDailyDigestWrite } from '../src/daily/issue'
import { xmlEscape } from '../src/epub/xhtml'
import { createClipPipeline } from '../src/pipeline/clip'
import { translateArticle as defaultTranslateArticle } from '../src/translate/openai'
import { asCandidateId, parseHttpUrl, type HttpUrl, type TranslateArticle } from '../src/types'
import { simulatorInputsDir } from './paths'

export type SimulatorExpect = 'image' | 'empty'
export type SimulatorKind = 'clip' | 'digest'

export type SimulatorImage = {
  readonly file: string
  readonly url: HttpUrl
}

export type SimulatorPage = {
  readonly id: string
  readonly kind: SimulatorKind
  readonly htmlFile?: string
  readonly url: HttpUrl
  readonly images: readonly SimulatorImage[]
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
  readonly kind?: unknown
  readonly html?: unknown
  readonly url?: unknown
  readonly image?: unknown
  readonly imageUrl?: unknown
  readonly images?: unknown
  readonly expect?: unknown
  readonly turns?: unknown
  readonly bandFrom?: unknown
}

const DIGEST_CANDIDATE = asCandidateId('cand_0000000000000000000000000000000a')
const DIGEST_ORIGIN = 'https://xteink-read-later.marufeuille.workers.dev'
const DIGEST_SECRET = 'simulator-digest-qr'

/**
 * Image-band pages do not call OpenAI.
 * A finished translation has to keep each X3IMG line, which is what the Japanese path already does.
 */
const keepImagePlaceholders: TranslateArticle = (article, deps) => {
  if (article.language === 'ja') {
    return defaultTranslateArticle(article, deps)
  }
  return defaultTranslateArticle({ ...article, language: 'ja' }, deps)
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

function imageMediaType(bytes: Uint8Array, file: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  throw new Error(`${file} is not a JPEG or PNG`)
}

function clipImages(
  raw: ManifestPage,
  index: number,
  inputsDir: string,
  htmlFile: string,
  html: string,
): readonly SimulatorImage[] {
  const listed: { readonly file: string; readonly url: string }[] = []
  if (Array.isArray(raw.images)) {
    for (const [imageIndex, entry] of raw.images.entries()) {
      if (!isRecord(entry)) {
        throw new Error(`simulator manifest pages[${index}].images[${imageIndex}] is not an object`)
      }
      listed.push({
        file: requiredString(entry.file, `pages[${index}].images[${imageIndex}].file`),
        url: requiredString(entry.url, `pages[${index}].images[${imageIndex}].url`),
      })
    }
  } else {
    listed.push({
      file: requiredString(raw.image, `pages[${index}].image`),
      url: requiredString(raw.imageUrl, `pages[${index}].imageUrl`),
    })
  }
  if (listed.length === 0) {
    throw new Error(`simulator manifest pages[${index}] needs an image`)
  }
  return listed.map((image) => {
    const url = httpUrl(image.url, `pages[${index}] image url`)
    if (!html.includes(url)) {
      throw new Error(`${htmlFile} does not reference ${url}`)
    }
    readFileSync(join(inputsDir, image.file))
    return { file: image.file, url }
  })
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
    const kind = raw.kind === undefined ? 'clip' : requiredString(raw.kind, `pages[${index}].kind`)
    if (kind !== 'clip' && kind !== 'digest') {
      throw new Error(`simulator manifest pages[${index}].kind must be clip or digest`)
    }
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
    const url = httpUrl(requiredString(raw.url, `pages[${index}].url`), `pages[${index}].url`)
    const htmlFile = kind === 'clip' ? requiredString(raw.html, `pages[${index}].html`) : undefined
    const images =
      kind === 'clip' && htmlFile !== undefined
        ? clipImages(raw, index, inputsDir, htmlFile, readFileSync(join(inputsDir, htmlFile), 'utf8'))
        : []
    if (kind === 'digest' && (raw.html !== undefined || raw.image !== undefined || raw.images !== undefined)) {
      throw new Error(`${String(raw.id)} is a digest page and does not take html or images`)
    }
    const page: SimulatorPage = {
      id: requiredString(raw.id, `pages[${index}].id`),
      kind,
      url,
      images,
      expect,
      turns,
      ...(htmlFile === undefined ? {} : { htmlFile }),
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

async function buildDigestEpub(page: SimulatorPage): Promise<Uint8Array> {
  const built = await buildDailyDigestWrite({
    date: '2026-09-27',
    items: [
      {
        candidateId: DIGEST_CANDIDATE,
        canonicalUrl: page.url,
        title: 'まとめのQR',
        summaryHtml: `<p>${xmlEscape(page.id)} の QR が画像として出るかを見る。</p>`,
      },
    ],
    qr: { publicOrigin: DIGEST_ORIGIN, secret: DIGEST_SECRET },
  })
  return built.write.epub
}

/** Clip the manifest pages with the existing pipeline. Local files stand in for the image URLs. */
export async function buildSimulatorEpubs(inputsDir = simulatorInputsDir()): Promise<readonly BuiltSimulatorPage[]> {
  const pages = loadSimulatorPages(inputsDir)
  const htmlByUrl = new Map<string, string>()
  const imageByUrl = new Map<string, { readonly bytes: Uint8Array; readonly mediaType: string }>()
  for (const page of pages) {
    if (page.kind !== 'clip' || page.htmlFile === undefined) {
      continue
    }
    htmlByUrl.set(page.url, readFileSync(join(inputsDir, page.htmlFile), 'utf8'))
    for (const image of page.images) {
      const bytes = new Uint8Array(readFileSync(join(inputsDir, image.file)))
      imageByUrl.set(image.url, { bytes, mediaType: imageMediaType(bytes, image.file) })
    }
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
      return new Response(image.bytes, { status: 200, headers: { 'content-type': image.mediaType } })
    }
    throw new Error(`unexpected fetch while building simulator epubs: ${url}`)
  }

  try {
    const pipeline = createClipPipeline({ translateArticle: keepImagePlaceholders })
    const built: BuiltSimulatorPage[] = []
    for (const page of pages) {
      if (page.kind === 'digest') {
        built.push({ page, epub: await buildDigestEpub(page) })
        continue
      }
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
