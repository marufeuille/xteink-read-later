import { readEpubPackageMetadata } from '../epub/opf-metadata'
import { err, ok, type InvalidEpubError, type PayloadTooLargeError, type Result } from '../types'

export const MAX_PURCHASED_EPUB_BYTES = 30_000_000

export type PurchasedBookFields = {
  readonly title: string
  readonly author: string | null
  readonly publishedAt: string | null
  readonly epub: Uint8Array
}

function formString(value: File | string | null): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function hasZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
}

async function formBytes(value: File | string | null): Promise<Uint8Array | null> {
  if (value === null || typeof value === 'string') {
    return null
  }
  return new Uint8Array(await value.arrayBuffer())
}

export async function parsePurchasedBookForm(
  form: FormData,
  options: { readonly metadataFallback?: boolean } = {},
): Promise<Result<PurchasedBookFields, InvalidEpubError | PayloadTooLargeError>> {
  const metadataFallback = options.metadataFallback === true
  let title = formString(form.get('title'))
  let author = formString(form.get('author'))
  if (title === null && !metadataFallback) {
    return err({ kind: 'invalid_epub', reason: 'multipart field title is required' })
  }

  const epub = (await formBytes(form.get('epub'))) ?? (await formBytes(form.get('file')))
  if (epub === null || epub.byteLength === 0) {
    return err({ kind: 'invalid_epub', reason: 'multipart field epub is required' })
  }
  if (epub.byteLength > MAX_PURCHASED_EPUB_BYTES) {
    return err({ kind: 'payload_too_large', bytes: epub.byteLength })
  }
  if (!hasZipMagic(epub)) {
    return err({ kind: 'invalid_epub', reason: 'uploaded file is not an EPUB zip' })
  }

  if (metadataFallback && (title === null || author === null)) {
    const metadata = readEpubPackageMetadata(epub)
    if (title === null) {
      title = metadata.title
    }
    if (author === null) {
      author = metadata.creator
    }
  }
  if (title === null) {
    return err({ kind: 'invalid_epub', reason: 'EPUB package has no dc:title' })
  }

  return ok({
    title,
    author,
    publishedAt: formString(form.get('publishedAt')),
    epub,
  })
}
