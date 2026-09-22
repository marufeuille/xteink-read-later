import type { Context, Hono } from 'hono'
import { unavailableClassification } from '../classify/taxonomy'
import { booksErrorHtml, booksFormHtml, booksResultHtml } from '../books/html'
import { htmlResponse } from '../candidates/html'
import { createR2Store } from '../store/r2'
import type {
  AppEnv,
  ArticleStore,
  CreateArticleStore,
  InvalidEpubError,
  PayloadTooLargeError,
  PurchasedBookBody,
} from '../types'
import { articleEpubKey, articleIdFromBytes, asEpubBytes, httpStatusByErrorKind, purchasedCanonicalUrl } from '../types'
import { defaultGetAccessIdentity, type GetAccessIdentity } from './access-identity'
import { unauthorizedResponse } from './auth'
import { denyIfCsrfMismatch, requireClipWebAuth, wantsJson, type ClipWebAuth } from './clip-web-auth'
import { toErrorResponse } from './error-response'
import { parsePurchasedBookForm } from './purchased-book'

function htmlClient(c: Context<AppEnv>): boolean {
  return (c.req.header('accept') ?? '').includes('text/html')
}

export type BookRouteDeps = {
  readonly store?: ArticleStore
  readonly createStore?: CreateArticleStore
  readonly getAccessIdentity?: GetAccessIdentity
}

function storeFor(env: Cloudflare.Env, deps: BookRouteDeps): ArticleStore {
  if (deps.store !== undefined) {
    return deps.store
  }
  return (deps.createStore ?? createR2Store)(env)
}

function bookFailure(
  error: InvalidEpubError | PayloadTooLargeError,
  html: boolean,
): Response {
  if (!html) {
    return toErrorResponse(error)
  }
  const kind = error.kind === 'payload_too_large' ? 'payload_too_large' : 'invalid_epub'
  return htmlResponse('購入した EPUB', booksErrorHtml(kind), httpStatusByErrorKind[error.kind])
}

export function mountBookRoutes(app: Hono<AppEnv>, deps: BookRouteDeps = {}): void {
  const webAuth = (c: Context<AppEnv>) =>
    requireClipWebAuth(c, deps.getAccessIdentity ?? defaultGetAccessIdentity)

  const authorize = async (c: Context<AppEnv>): Promise<ClipWebAuth | Response> => {
    const auth = await webAuth(c)
    if (auth instanceof Response && !htmlClient(c)) {
      return unauthorizedResponse('bearer')
    }
    return auth
  }

  const show = async (c: Context<AppEnv>) => {
    const auth = await authorize(c)
    if (auth instanceof Response) {
      return auth
    }
    return htmlResponse('購入した EPUB', booksFormHtml(auth.csrfToken))
  }

  const uploadBook = async (c: Context<AppEnv>) => {
    const auth = await authorize(c)
    if (auth instanceof Response) {
      return auth
    }
    const html = auth.via === 'access' && !wantsJson(c)
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return bookFailure({ kind: 'invalid_epub', reason: 'Request body must be multipart form data' }, html)
    }
    const csrf = form.get('csrf')
    const denied = await denyIfCsrfMismatch(auth, typeof csrf === 'string' ? csrf : '')
    if (denied !== null) {
      return denied
    }
    const parsed = await parsePurchasedBookForm(form, { metadataFallback: auth.via === 'access' })
    if (!parsed.ok) {
      return bookFailure(parsed.error, html)
    }

    const id = await articleIdFromBytes(parsed.value.epub)
    const canonicalUrl = purchasedCanonicalUrl(id)
    await storeFor(c.env, deps).put({
      id,
      title: parsed.value.title,
      author: parsed.value.author,
      publishedAt: parsed.value.publishedAt,
      sourceUrl: canonicalUrl,
      canonicalUrl,
      language: 'ja',
      translated: false,
      classification: unavailableClassification('skipped'),
      epub: asEpubBytes(parsed.value.epub),
    })

    const response: PurchasedBookBody = {
      id,
      title: parsed.value.title,
      author: parsed.value.author,
      publishedAt: parsed.value.publishedAt,
      sourceUrl: canonicalUrl,
      canonicalUrl,
      language: 'ja',
      translated: false,
      status: 'ready',
      epubPath: `/${articleEpubKey(id)}`,
    }
    if (html) {
      return htmlResponse(
        '購入した EPUB',
        booksResultHtml({
          title: parsed.value.title,
          author: parsed.value.author,
          secret: c.env.CLIP_TOKEN,
        }),
      )
    }
    return c.json(response, 200)
  }

  app.on('GET', ['/books', '/books/'], show)
  app.on('POST', ['/books', '/books/'], uploadBook)
}
