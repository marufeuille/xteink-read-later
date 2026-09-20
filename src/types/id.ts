declare const articleIdBrand: unique symbol
declare const httpUrlBrand: unique symbol
declare const epubBytesBrand: unique symbol

export type ArticleId = string & { readonly [articleIdBrand]: void }
export type HttpUrl = string & { readonly [httpUrlBrand]: void }
export type EpubBytes = Uint8Array & { readonly [epubBytesBrand]: void }

declare const clipJobIdBrand: unique symbol
declare const clipRunIdBrand: unique symbol

export type ClipJobId = string & { readonly [clipJobIdBrand]: void }
export type ClipRunId = string & { readonly [clipRunIdBrand]: void }

export type ArticleMetaKey = `articles/${ArticleId}/meta.json`
export type ArticleEpubKey = `articles/${ArticleId}/book.epub`
export type ArticleObjectKey = ArticleMetaKey | ArticleEpubKey
export type ClipJobKey = `jobs/${ClipJobId}.json`

const ARTICLE_ID_PATTERN = /^art_[a-f0-9]{32}$/
const CLIP_JOB_ID_PATTERN = /^job_[a-f0-9]{32}$/
const CLIP_RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex32(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest)).slice(0, 32)
}

export function isArticleId(value: string): value is ArticleId {
  return ARTICLE_ID_PATTERN.test(value)
}

export function isClipJobId(value: string): value is ClipJobId {
  return CLIP_JOB_ID_PATTERN.test(value)
}

export function isClipRunId(value: string): value is ClipRunId {
  return CLIP_RUN_ID_PATTERN.test(value)
}

export function asArticleId(value: string): ArticleId {
  if (!isArticleId(value)) {
    throw new TypeError(`Invalid article id: ${value}`)
  }
  return value
}

export function asClipJobId(value: string): ClipJobId {
  if (!isClipJobId(value)) {
    throw new TypeError(`Invalid clip job id: ${value}`)
  }
  return value
}

export function asClipRunId(value: string): ClipRunId {
  if (!isClipRunId(value)) {
    throw new TypeError(`Invalid clip run id: ${value}`)
  }
  return value
}

export function newClipRunId(): ClipRunId {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return asClipRunId(`run_${bytesToHex(bytes)}`)
}

export async function articleIdFromCanonicalUrl(canonicalUrl: HttpUrl): Promise<ArticleId> {
  const hex = await sha256Hex32(new TextEncoder().encode(canonicalUrl))
  return asArticleId(`art_${hex}`)
}

export async function articleIdFromBytes(bytes: Uint8Array): Promise<ArticleId> {
  const hex = await sha256Hex32(bytes)
  return asArticleId(`art_${hex}`)
}

export async function clipJobIdFromUrl(url: HttpUrl): Promise<ClipJobId> {
  const hex = await sha256Hex32(new TextEncoder().encode(url))
  return asClipJobId(`job_${hex}`)
}

export function purchasedCanonicalUrl(id: ArticleId): HttpUrl {
  const url = parseHttpUrl(`https://purchased.invalid/books/${id}`)
  if (url === null) {
    throw new TypeError(`Invalid purchased canonical URL for ${id}`)
  }
  return url
}

export function parseHttpUrl(value: string): HttpUrl | null {
  if (!URL.canParse(value)) {
    return null
  }
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  return url.href as HttpUrl
}

export function asEpubBytes(value: Uint8Array): EpubBytes {
  return value as EpubBytes
}

export function articleMetaKey(id: ArticleId): ArticleMetaKey {
  return `articles/${id}/meta.json`
}

export function articleEpubKey(id: ArticleId): ArticleEpubKey {
  return `articles/${id}/book.epub`
}

export function clipJobKey(id: ClipJobId): ClipJobKey {
  return `jobs/${id}.json`
}
